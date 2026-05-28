// SSO relying-party wiring. Mounts @atlas/sso when SSO_ISSUER env is set.
// JIT-creates the local users row on first login; subsequent logins upsert.

import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { hash } from "@atlas/auth"
import {
  ensureSsoStateTable,
  type IdTokenClaims,
  mountSso,
  type SsoConfig,
} from "@atlas/sso"
import type { Conn } from "@atlas/server"
import { issueSession, revokeAllSessions } from "../security/sessions.ts"
import { logEvent } from "../security/audit.ts"
import { clientIp, userAgent } from "../security/ratelimit.ts"
import { isReservedLogin, isValidLogin, normalizeLogin } from "../util/username.ts"

const claimUsername = (claims: IdTokenClaims): string => {
  const raw = claims.preferred_username ?? (claims.email ? claims.email.split("@")[0] : null)
  if (!raw) throw new Error("ID token lacks preferred_username and email")
  const normalized = normalizeLogin(String(raw))
  if (!isValidLogin(normalized)) throw new Error(`Username '${normalized}' from IdP is invalid`)
  if (isReservedLogin(normalized)) throw new Error(`Username '${normalized}' is reserved`)
  return normalized
}

const claimEmail = (claims: IdTokenClaims): string => {
  if (!claims.email) throw new Error("ID token lacks email claim")
  return String(claims.email).toLowerCase()
}

const placeholderHash = async (): Promise<string> =>
  hash("disabled-local-password-" + Math.random().toString(36))

type SyncedUser = { id: number; username: string; name: string; email: string; is_owner: boolean }

const upsertUser = async (db: Connection, claims: IdTokenClaims): Promise<SyncedUser> => {
  const email = claimEmail(claims)
  const username = claimUsername(claims)
  const name = (claims.name as string | undefined)?.trim() || username

  const byEmail = await db.one(
    from("users").where((q) => q("email").equals(email)).select("id", "is_owner"),
  ) as { id: number; is_owner: boolean } | null
  const target = byEmail ?? (await db.one(
    from("users").where((q) => q("username").equals(username)).select("id", "is_owner"),
  ) as { id: number; is_owner: boolean } | null)

  if (target) {
    await db.execute(
      from("users").where((q) => q("id").equals(target.id)).update({ email, username, name }),
    )
    return { id: target.id, username, name, email, is_owner: target.is_owner }
  }
  // Refuse if an org owns this login — same namespace rule as /signup.
  const orgTaken = await db.one(
    from("orgs").where((q) => q("login").equals(username)).select("id"),
  )
  if (orgTaken) throw new Error(`Username '${username}' is taken by an org`)

  const password = await placeholderHash()
  const inserted = await db.execute(
    from("users")
      .insert({ email, username, name, password, is_owner: false })
      .returning("id", "is_owner"),
  ) as Array<{ id: number; is_owner: boolean }>
  const row = inserted[0]
  if (!row) throw new Error("user insert failed")
  return { id: row.id, username, name, email, is_owner: row.is_owner }
}

export const setupTangleSso = async (
  db: Connection,
  env: { issuerUrl: string; clientId: string; clientSecret: string; secret: string },
) => {
  await ensureSsoStateTable(db)
  const cfg: SsoConfig = {
    db,
    issuerUrl: env.issuerUrl,
    clientId: env.clientId,
    clientSecret: env.clientSecret,
    onAuthenticated: async (db, claims) => {
      const user = await upsertUser(db, claims)
      return { localUserId: user.id, displayName: user.name }
    },
    issueSession: async (conn: Conn, _user, claims) => {
      const user = await upsertUser(db, claims)
      const sess = await issueSession(
        db,
        {
          id: user.id,
          email: user.email,
          username: user.username,
          name: user.name,
          is_owner: user.is_owner,
        },
        env.secret,
        { ip: clientIp(conn.request), userAgent: userAgent(conn.request) },
      )
      logEvent(db, {
        userId: user.id,
        event: "sso.login.ok",
        metadata: { iss: claims.iss },
        ip: clientIp(conn.request),
        userAgent: userAgent(conn.request),
      })
      // Carry the token back on the redirect fragment so Tangle's SPA can
      // pick it up the same way it does for password login.
      const target = new URL(conn.request.url)
      target.pathname = "/"
      target.hash = `token=${encodeURIComponent(sess.token)}`
      target.search = ""
      const headers = new Headers(conn.respHeaders)
      headers.set("location", target.toString())
      return { ...conn, status: 302, halted: true, respHeaders: headers }
    },
    findLocalUserBySub: async (db, sub) => {
      const id = Number(sub)
      if (!Number.isFinite(id)) return null
      const row = await db.one(
        from("users").where((q) => q("id").equals(id)).select("id"),
      ) as { id: number } | null
      return row?.id ?? null
    },
    invalidateSessions: async (db, params) => {
      if (params.localUserId === null || params.localUserId === undefined) return
      const id = typeof params.localUserId === "string" ? Number(params.localUserId) : params.localUserId
      if (!Number.isFinite(id)) return
      await revokeAllSessions(db, id)
    },
  }
  return mountSso(cfg)
}
