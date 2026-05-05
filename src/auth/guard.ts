import { createHash } from "node:crypto"
import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { token } from "@atlas/auth"
import { assign, halt } from "@atlas/server"
import type { PipeFn } from "@atlas/server"
import { isSessionActive, touchSession } from "../security/sessions.ts"

export const APP_TOKEN_PREFIX = "tangle_pat_"

export const hashToken = (raw: string): string =>
  createHash("sha256").update(raw).digest("hex")

type AppRow = { id: number; user_id: number; scopes: string }
type UserRow = {
  id: number
  email: string
  username: string
  name: string
  is_owner: boolean
  deleted_at?: string | null
}

const ACCOUNT_DELETED_ERROR =
  "Account is scheduled for deletion. Click the cancel link in your email to restore it."

type RequireAuthOptions = {
  secret: string
  db: Connection
  /** If set, the PAT used must include this scope to pass. */
  scope?: string
}

export const requireAuth = (opts: RequireAuthOptions): PipeFn =>
  async (conn) => {
    const header = conn.headers.get("authorization")
    if (!header?.startsWith("Bearer ")) {
      return halt(conn, 401, {
        error: "Missing or invalid authorization header. Send 'Authorization: Bearer <token>'.",
        code: "unauthorized",
      })
    }
    const t = header.slice(7).trim()

    if (t.startsWith(APP_TOKEN_PREFIX)) {
      const tokenHash = hashToken(t)
      const app = await opts.db.one(
        from("apps").where(q => q("token_hash").equals(tokenHash)).select("id", "user_id", "scopes"),
      ) as AppRow | null
      if (!app) {
        return halt(conn, 401, { error: "Invalid or revoked app token", code: "unauthorized" })
      }
      if (opts.scope) {
        const scopes = (app.scopes ?? "").split(/\s+/).filter(Boolean)
        if (!scopes.includes(opts.scope)) {
          return halt(conn, 403, {
            error: `Insufficient scope — '${opts.scope}' is required, token has [${scopes.join(", ")}]`,
            code: "forbidden",
          })
        }
      }
      const user = await opts.db.one(
        from("users")
          .where(q => q("id").equals(app.user_id))
          .select("id", "email", "username", "name", "is_owner", "deleted_at"),
      ) as UserRow | null
      if (!user) {
        return halt(conn, 401, { error: "App token references a missing user", code: "unauthorized" })
      }
      if (user.deleted_at) {
        return halt(conn, 403, { error: ACCOUNT_DELETED_ERROR, code: "forbidden" })
      }
      void opts.db.execute(
        from("apps").where(q => q("id").equals(app.id)).update({ last_used_at: raw("NOW()") }),
      ).catch(() => {})
      return assign(conn, {
        auth: {
          id: user.id,
          email: user.email,
          username: user.username,
          name: user.name,
          is_owner: user.is_owner,
          via: "app",
          app_id: app.id,
        },
      })
    }

    let payload: any
    try {
      payload = await token.verify(t, opts.secret)
    } catch {
      return halt(conn, 401, {
        error: "Invalid or expired token. Re-authenticate to get a fresh token.",
        code: "unauthorized",
      })
    }

    // Regular user JWT — must match an active session row when a jti is
    // present.
    const jti = typeof payload?.jti === "string" ? payload.jti : null
    if (jti) {
      const sess = await isSessionActive(opts.db, jti)
      if (!sess.active) {
        return halt(conn, 401, { error: "Session revoked. Sign in again.", code: "unauthorized" })
      }
      touchSession(opts.db, jti)
    }
    if (typeof payload?.id === "number") {
      const u = await opts.db.one(
        from("users").where(q => q("id").equals(payload.id)).select("deleted_at"),
      ) as { deleted_at: string | null } | null
      if (u?.deleted_at) {
        return halt(conn, 403, { error: ACCOUNT_DELETED_ERROR, code: "forbidden" })
      }
    }

    return assign(conn, { auth: { ...payload, jti } })
  }

// Optional-auth variant. Tries to identify the caller from a Bearer
// token; if there is no token (or it's invalid) the conn passes
// through with `auth = null`. Used by the browse routes so public
// repos can be read without credentials. Routes that gate on
// `auth.id` should treat `null` as anonymous and lean on
// resolveRepoAccess(db, repo, null) — which returns readable for
// public repos, hidden for private.
export const optionalAuth = (opts: { secret: string; db: Connection }): PipeFn =>
  async (conn) => {
    const header = conn.headers.get("authorization")
    if (!header?.startsWith("Bearer ")) {
      return assign(conn, { auth: null })
    }
    // Reuse requireAuth's full logic, but soften the failure: if it
    // halts, swallow the halt and pass the conn through anonymously.
    const guarded = requireAuth(opts)
    const result = await guarded(conn)
    if (result.halted) {
      // The token was present but invalid. Surface it as anonymous
      // rather than 401 — anonymous-with-bad-creds is still
      // anonymous. (A user typo'ing their PAT in `git clone` of a
      // public repo should still succeed.)
      return assign(conn, { auth: null, status: 200, halted: false, body: null })
    }
    return result
  }
