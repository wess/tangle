import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { get, json, parseJson, patch, pipeline, post } from "@atlas/server"
import { hash, verify } from "@atlas/auth"
import { requireAuth } from "../auth/guard.ts"
import { putHeader, setStatus, stream } from "@atlas/server"
import type { StorageHandle } from "../storage/index.ts"
import { drop, fetchObject, makeKey, put } from "../storage/index.ts"
import { isEmail, isReservedLogin, isValidLogin, normalizeLogin } from "../util/username.ts"
import { issueSession, revokeAllSessions } from "../security/sessions.ts"
import { logEvent } from "../security/audit.ts"
import { checkRate, clientIp, userAgent } from "../security/ratelimit.ts"
import { apiError } from "../util/errors.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id
const authJti = (c: any): string | null => (c.assigns.auth as { jti?: string | null }).jti ?? null

export const userRoutes = (db: Connection, secret: string, store: StorageHandle) => {
  const guard = pipeline(requireAuth({ secret, db }))
  const authed = pipeline(requireAuth({ secret, db }), parseJson)

  return [
    get("/me", guard(async (c) => {
      const userId = authId(c)
      const user = await db.one(
        from("users")
          .where(q => q("id").equals(userId))
          .select("id", "email", "username", "name", "bio", "avatar_key", "is_owner", "discoverable", "created_at"),
      )
      if (!user) return apiError(c, "not_found", "User not found")
      return json(c, 200, user)
    })),

    patch("/me", authed(async (c) => {
      const userId = authId(c)
      const body = c.body as {
        name?: string; email?: string; username?: string; bio?: string
        discoverable?: boolean
      }
      const name = body.name?.trim()
      const email = body.email?.trim().toLowerCase()
      const usernameRaw = body.username?.trim()
      const username = usernameRaw ? normalizeLogin(usernameRaw) : undefined
      const bio = body.bio?.trim()
      const discoverable = typeof body.discoverable === "boolean" ? body.discoverable : undefined

      if (!name && !email && !username && bio === undefined && discoverable === undefined) {
        return apiError(c, "validation", "Provide at least one field to update")
      }

      const updates: Record<string, unknown> = {}
      if (name) updates.name = name
      if (email) {
        if (!isEmail(email)) return apiError(c, "validation", "Invalid email format")
        const existing = await db.one(
          from("users").where(q => q("email").equals(email)).select("id"),
        ) as { id: number } | null
        if (existing && existing.id !== userId) return apiError(c, "conflict", "Email already in use")
        updates.email = email
      }
      if (username) {
        if (!isValidLogin(username)) {
          return apiError(c, "validation", "Username must be 1-32 chars, lowercase letters, digits, and hyphens")
        }
        if (isReservedLogin(username)) return apiError(c, "conflict", "Username is reserved")
        const existing = await db.one(
          from("users").where(q => q("username").equals(username)).select("id"),
        ) as { id: number } | null
        if (existing && existing.id !== userId) return apiError(c, "conflict", "Username already in use")
        const orgTaken = await db.one(
          from("orgs").where(q => q("login").equals(username)).select("id"),
        )
        if (orgTaken) return apiError(c, "conflict", "Username already in use")
        updates.username = username
      }
      if (bio !== undefined) updates.bio = bio || null
      if (discoverable !== undefined) updates.discoverable = discoverable

      await db.execute(
        from("users").where(q => q("id").equals(userId)).update(updates),
      )

      // Identity changes (email/username/name) are baked into the JWT
      // payload, so re-issue and revoke siblings. Bio/discoverability
      // don't carry into the token, so leave sessions alone.
      const identityChanged = !!email || !!username || !!name
      const fresh = await db.one(
        from("users").where(q => q("id").equals(userId)).select("id", "email", "username", "name", "bio", "avatar_key", "is_owner", "discoverable", "created_at"),
      ) as { id: number; email: string; username: string; name: string; bio: string | null; avatar_key: string | null; is_owner: boolean; discoverable: boolean; created_at: string }

      const out: Record<string, unknown> = { ...fresh }
      if (identityChanged) {
        const sess = await issueSession(db, fresh, secret, {
          ip: clientIp(c.request),
          userAgent: userAgent(c.request),
        })
        await revokeAllSessions(db, userId, sess.jti)
        out.token = sess.token
      }
      return json(c, 200, out)
    })),

    post("/me/password", authed(async (c) => {
      const userId = authId(c)
      const body = c.body as { current_password?: string; new_password?: string; currentPassword?: string; newPassword?: string }
      const current = body.current_password ?? body.currentPassword
      const next = body.new_password ?? body.newPassword

      if (!current || !next) return apiError(c, "validation", "current_password and new_password required")
      if (next.length < 8) return apiError(c, "validation", "New password must be at least 8 characters")

      const rate = await checkRate(db, `pwchange:user:${userId}`, 10, 900)
      if (!rate.ok) {
        return apiError(c, "rate_limited", "Too many password change attempts. Try again later.", { retry_after: rate.retryAfterSeconds, })
      }

      const user = await db.one(
        from("users").where(q => q("id").equals(userId)).select("id", "password"),
      ) as { id: number; password: string } | null
      if (!user) return apiError(c, "not_found", "User not found")

      const ok = await verify(current, user.password)
      if (!ok) return apiError(c, "unauthorized", "Current password is incorrect")

      const hashed = await hash(next)
      await db.execute(
        from("users").where(q => q("id").equals(userId)).update({ password: hashed }),
      )

      const currentJti = authJti(c)
      const revoked = await revokeAllSessions(db, userId, currentJti ?? undefined)
      logEvent(db, {
        userId,
        event: "password.changed",
        metadata: { revoked_other_sessions: revoked },
        ip: clientIp(c.request),
        userAgent: userAgent(c.request),
      })
      return json(c, 200, { ok: true, revoked_other_sessions: revoked })
    })),

    get("/users/search", guard(async (c) => {
      const userId = authId(c)
      const url = new URL(c.request.url)
      const qParam = (url.searchParams.get("q") ?? "").trim()
      if (!qParam) return json(c, 200, [])
      const pattern = `%${qParam.replace(/[%_]/g, m => `\\${m}`)}%`
      // Email is intentionally NOT searchable — substring queries on the
      // email column would let any authenticated user enumerate
      // addresses. Username and display name are public-by-design.
      const rows = await db.all(
        from("users")
          .where(q => q.or(q("username").ilike(pattern), q("name").ilike(pattern)))
          .where(q => q("deleted_at").isNull())
          .where(q => q("discoverable").equals(true))
          .select("id", "username", "name", "avatar_key")
          .orderBy("username", "ASC")
          .limit(11),
      ) as Array<{ id: number; username: string; name: string; avatar_key: string | null }>
      return json(c, 200, rows.filter(r => r.id !== userId).slice(0, 10))
    })),

    get("/u/:username", guard(async (c) => {
      const userId = authId(c)
      const username = normalizeLogin(c.params.username)
      const row = await db.one(
        from("users")
          .where(q => q("username").equals(username))
          .select("id", "username", "name", "bio", "avatar_key", "discoverable", "deleted_at"),
      ) as { id: number; username: string; name: string; bio: string | null; avatar_key: string | null; discoverable: boolean; deleted_at: string | null } | null
      if (!row || row.deleted_at) return apiError(c, "not_found", "User not found")
      if (!row.discoverable && row.id !== userId) {
        return apiError(c, "not_found", "User not found")
      }
      return json(c, 200, {
        id: row.id,
        username: row.username,
        name: row.name,
        bio: row.bio,
        avatar_key: row.avatar_key,
      })
    })),

    // Avatar upload — multipart with a single `file` field. Caps the
    // image at 4 MB (anything larger is overkill for an avatar) and
    // verifies the content-type starts with image/. Old avatars are
    // dropped from storage after the new one lands so we don't
    // silently accumulate orphans.
    post("/me/avatar", guard(async (c) => {
      const userId = authId(c)
      const form = await c.request.formData().catch(() => null)
      if (!form) return apiError(c, "validation", "Expected multipart/form-data")
      const file = form.get("file")
      if (!(file instanceof Blob)) return apiError(c, "validation", "file field required")
      if (file.size > 4 * 1024 * 1024) return apiError(c, "too_large", "Avatar must be 4 MB or smaller")
      const ct = file.type || "application/octet-stream"
      if (!ct.startsWith("image/")) return apiError(c, "validation", "Avatar must be an image")

      const filename = (file as File).name?.trim() || "avatar"
      const key = makeKey(userId, filename)
      await put(store, key, file, ct)

      const prev = await db.one(
        from("users").where(q => q("id").equals(userId)).select("avatar_key"),
      ) as { avatar_key: string | null } | null
      await db.execute(from("users").where(q => q("id").equals(userId)).update({ avatar_key: key }))
      if (prev?.avatar_key && prev.avatar_key !== key) {
        // Best-effort drop — a failed delete leaves an orphan but
        // never breaks the user's avatar update.
        void drop(store, prev.avatar_key).catch(() => {})
      }
      return json(c, 200, { avatar_key: key })
    })),

    // Public avatar fetch — by user id, no auth required (the SPA
    // shows them in the topbar / sidebar / repo lists). The avatar key
    // is just an opaque storage path; we look it up rather than letting
    // the SPA construct a URL with arbitrary keys.
    get("/avatars/:user_id", async (c) => {
      const id = Number(c.params.user_id)
      if (!Number.isFinite(id)) return apiError(c, "not_found", "Not found")
      const row = await db.one(
        from("users").where(q => q("id").equals(id)).select("avatar_key", "deleted_at"),
      ) as { avatar_key: string | null; deleted_at: string | null } | null
      if (!row || row.deleted_at || !row.avatar_key) return apiError(c, "not_found", "No avatar")
      const res = await fetchObject(store, row.avatar_key).catch(() => null)
      if (!res || !res.body) return apiError(c, "not_found", "Avatar bytes missing")
      const ct = res.headers.get("content-type") ?? "application/octet-stream"
      // Cache for an hour — avatar updates won't propagate instantly,
      // but it spares the storage backend from rehydrating on every
      // page render.
      const cached = putHeader(putHeader(setStatus(c, 200), "content-type", ct), "cache-control", "public, max-age=3600")
      return stream(cached, 200, res.body)
    }),
  ]
}
