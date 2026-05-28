// Castle integration: machine-to-machine endpoints for centrally-managed
// user provisioning. Opt-in: gated by the CASTLE_ADMIN_TOKEN env var.
// When unset, the routes simply aren't mounted (see server.ts) and Tangle
// behaves exactly as it did before this module landed.

import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { del, get, json, parseJson, pipeline, post } from "@atlas/server"
import { revokeAllSessions } from "../security/sessions.ts"
import { logEvent } from "../security/audit.ts"
import { clientIp, userAgent } from "../security/ratelimit.ts"
import { isEmail, isReservedLogin, isValidLogin, normalizeLogin } from "../util/username.ts"
import { requireCastleToken } from "./guard.ts"

type UserRow = { id: number; password: string }

const argonRe = /^\$argon2(id|i|d)\$/

export const castleRoutes = (db: Connection, adminToken: string) => {
  if (!adminToken) return []
  const guard = pipeline(requireCastleToken(adminToken), parseJson)
  const guardNoBody = pipeline(requireCastleToken(adminToken))

  return [
    get("/castle/health", guardNoBody(async (c) => json(c, 200, { ok: true, service: "tangle" }))),

    post("/castle/users", guard(async (c) => {
      const body = c.body as {
        email?: string
        username?: string
        name?: string
        password_hash?: string
        is_owner?: boolean
      }
      const email = body.email?.trim().toLowerCase()
      const usernameRaw = body.username?.trim()
      const name = body.name?.trim()
      const passwordHash = body.password_hash
      const isOwner = body.is_owner === true

      if (!email || !usernameRaw || !name || !passwordHash) {
        return json(c, 422, { error: "email, username, name, password_hash required" })
      }
      if (!isEmail(email)) return json(c, 422, { error: "invalid email" })
      const username = normalizeLogin(usernameRaw)
      if (!isValidLogin(username)) {
        return json(c, 422, { error: "username must be 1-32 chars, lowercase letters, digits, hyphens" })
      }
      if (isReservedLogin(username)) {
        return json(c, 422, { error: "username is reserved" })
      }
      if (!argonRe.test(passwordHash)) {
        return json(c, 422, { error: "password_hash must be an argon2 hash" })
      }

      const byEmail = await db.one(
        from("users").where(q => q("email").equals(email)).select("id", "password"),
      ) as UserRow | null
      const target = byEmail ?? (await db.one(
        from("users").where(q => q("username").equals(username)).select("id", "password"),
      ) as UserRow | null)

      // Org logins share the user-login namespace so `tangle.io/<name>/...`
      // routes are unambiguous. If an org owns this name, refuse — Castle
      // should pick a different username.
      if (!target) {
        const orgTaken = await db.one(
          from("orgs").where(q => q("login").equals(username)).select("id"),
        )
        if (orgTaken) return json(c, 409, { error: "username conflicts with an existing org" })
      }

      let created = false
      let userId: number
      let revokedSessions = 0

      if (target) {
        userId = target.id
        const passwordChanged = target.password !== passwordHash
        await db.execute(
          from("users").where(q => q("id").equals(target.id)).update({
            email,
            username,
            name,
            password: passwordHash,
            is_owner: isOwner,
          }),
        )
        if (passwordChanged) {
          revokedSessions = await revokeAllSessions(db, target.id)
          logEvent(db, {
            userId: target.id,
            event: "castle.password_changed",
            ip: clientIp(c.request),
            userAgent: userAgent(c.request),
            metadata: { revoked_sessions: revokedSessions },
          })
        }
      } else {
        const inserted = await db.execute(
          from("users")
            .insert({
              email,
              username,
              name,
              password: passwordHash,
              is_owner: isOwner,
            })
            .returning("id"),
        ) as Array<{ id: number }>
        userId = inserted[0]!.id
        created = true
        logEvent(db, {
          userId,
          event: "castle.user_created",
          ip: clientIp(c.request),
          userAgent: userAgent(c.request),
        })
      }

      return json(c, created ? 201 : 200, {
        id: userId,
        email,
        username,
        name,
        created,
        revoked_sessions: revokedSessions,
      })
    })),

    del("/castle/users/by-email/:email", guardNoBody(async (c) => {
      const email = decodeURIComponent(c.params.email ?? "").toLowerCase()
      if (!email) return json(c, 422, { error: "missing email" })
      const row = await db.one(
        from("users").where(q => q("email").equals(email)).select("id"),
      ) as { id: number } | null
      if (!row) return json(c, 404, { error: "user not found" })
      // Hard-delete: cascades through sessions, repos owned by this user, etc.
      // Castle is the central admin making an explicit, audited choice.
      await db.execute(from("users").where(q => q("id").equals(row.id)).del())
      logEvent(db, {
        userId: row.id,
        event: "castle.user_deleted",
        ip: clientIp(c.request),
        userAgent: userAgent(c.request),
      })
      return json(c, 200, { ok: true, deleted: row.id })
    })),
  ]
}
