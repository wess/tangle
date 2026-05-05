import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { del, get, json, parseJson, patch, pipeline, post } from "@atlas/server"
import { requireAuth } from "../auth/guard.ts"
import { isReservedLogin, isValidLogin, normalizeLogin } from "../util/username.ts"
import { logEvent } from "../security/audit.ts"
import { clientIp, userAgent } from "../security/ratelimit.ts"
import { apiError } from "../util/errors.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

export const orgRoutes = (db: Connection, secret: string) => {
  const guard = pipeline(requireAuth({ secret, db }))
  const authed = pipeline(requireAuth({ secret, db }), parseJson)

  return [
    get("/orgs", guard(async (c) => {
      const userId = authId(c)
      // Orgs the user belongs to (owner or member). Plain join.
      const text = `
        SELECT o.id, o.login, o.name, o.description, o.avatar_key, o.created_at, m.role
        FROM orgs o
        JOIN org_members m ON m.org_id = o.id
        WHERE m.user_id = $1
        ORDER BY o.login ASC
      `
      const rows = await db.execute({ text, values: [userId] }) as Array<unknown>
      return json(c, 200, rows)
    })),

    post("/orgs", authed(async (c) => {
      const userId = authId(c)
      const body = c.body as { login?: string; name?: string; description?: string }
      const loginRaw = body.login?.trim()
      if (!loginRaw) return apiError(c, "validation", "login required")
      const login = normalizeLogin(loginRaw)
      if (!isValidLogin(login)) {
        return apiError(c, "validation", "Login must be 1-32 chars, lowercase letters, digits, and hyphens")
      }
      if (isReservedLogin(login)) return apiError(c, "conflict", "Login is reserved")
      // Login namespace is shared with users — prevent collisions both
      // ways so `tangle.io/<login>/<repo>` routes unambiguously.
      const userTaken = await db.one(
        from("users").where(q => q("username").equals(login)).select("id"),
      )
      if (userTaken) return apiError(c, "conflict", "Login already in use")
      const orgTaken = await db.one(
        from("orgs").where(q => q("login").equals(login)).select("id"),
      )
      if (orgTaken) return apiError(c, "conflict", "Login already in use")

      const inserted = await db.execute(
        from("orgs").insert({
          login,
          name: body.name?.trim() || login,
          description: body.description?.trim() || null,
          created_by: userId,
        }).returning("id", "login", "name", "description", "created_at"),
      ) as Array<{ id: number; login: string; name: string; description: string | null; created_at: string }>
      const org = inserted[0]!

      await db.execute(
        from("org_members").insert({ org_id: org.id, user_id: userId, role: "owner" }),
      )

      logEvent(db, {
        userId,
        event: "org.created",
        metadata: { org_id: org.id, login: org.login },
        ip: clientIp(c.request),
        userAgent: userAgent(c.request),
      })

      return json(c, 201, { ...org, role: "owner" })
    })),

    get("/orgs/:login", guard(async (c) => {
      const login = normalizeLogin(c.params.login)
      const org = await db.one(
        from("orgs")
          .where(q => q("login").equals(login))
          .select("id", "login", "name", "description", "avatar_key", "created_at"),
      )
      if (!org) return apiError(c, "not_found", "Org not found")
      return json(c, 200, org)
    })),

    patch("/orgs/:login", authed(async (c) => {
      const userId = authId(c)
      const login = normalizeLogin(c.params.login)
      const org = await db.one(
        from("orgs").where(q => q("login").equals(login)).select("id"),
      ) as { id: number } | null
      if (!org) return apiError(c, "not_found", "Org not found")
      const member = await db.one(
        from("org_members")
          .where(q => q("org_id").equals(org.id))
          .where(q => q("user_id").equals(userId))
          .select("role"),
      ) as { role: string } | null
      if (!member || member.role !== "owner") {
        return apiError(c, "forbidden", "Only org owners can edit org details")
      }
      const body = c.body as { name?: string; description?: string }
      const updates: Record<string, unknown> = {}
      if (body.name !== undefined) updates.name = body.name.trim() || login
      if (body.description !== undefined) updates.description = body.description.trim() || null
      if (Object.keys(updates).length === 0) return apiError(c, "validation", "No fields to update")
      await db.execute(from("orgs").where(q => q("id").equals(org.id)).update(updates))
      const fresh = await db.one(
        from("orgs").where(q => q("id").equals(org.id)).select("id", "login", "name", "description", "avatar_key", "created_at"),
      )
      return json(c, 200, fresh)
    })),

    get("/orgs/:login/members", guard(async (c) => {
      const login = normalizeLogin(c.params.login)
      const org = await db.one(
        from("orgs").where(q => q("login").equals(login)).select("id"),
      ) as { id: number } | null
      if (!org) return apiError(c, "not_found", "Org not found")
      const text = `
        SELECT u.id, u.username, u.name, u.avatar_key, m.role, m.created_at
        FROM org_members m
        JOIN users u ON u.id = m.user_id
        WHERE m.org_id = $1 AND u.deleted_at IS NULL
        ORDER BY m.role = 'owner' DESC, u.username ASC
      `
      const rows = await db.execute({ text, values: [org.id] })
      return json(c, 200, rows)
    })),

    post("/orgs/:login/members", authed(async (c) => {
      const userId = authId(c)
      const login = normalizeLogin(c.params.login)
      const org = await db.one(
        from("orgs").where(q => q("login").equals(login)).select("id"),
      ) as { id: number } | null
      if (!org) return apiError(c, "not_found", "Org not found")
      const owner = await db.one(
        from("org_members")
          .where(q => q("org_id").equals(org.id))
          .where(q => q("user_id").equals(userId))
          .where(q => q("role").equals("owner"))
          .select("id"),
      )
      if (!owner) return apiError(c, "forbidden", "Only org owners can add members")

      const body = c.body as { username?: string; role?: string }
      const username = body.username ? normalizeLogin(body.username) : ""
      const role = (body.role ?? "member").trim()
      if (!username) return apiError(c, "validation", "username required")
      if (role !== "owner" && role !== "member") return apiError(c, "validation", "role must be owner or member")

      const target = await db.one(
        from("users").where(q => q("username").equals(username)).select("id"),
      ) as { id: number } | null
      if (!target) return apiError(c, "not_found", "User not found")

      const existing = await db.one(
        from("org_members")
          .where(q => q("org_id").equals(org.id))
          .where(q => q("user_id").equals(target.id))
          .select("id"),
      )
      if (existing) return apiError(c, "conflict", "User is already a member")

      await db.execute(
        from("org_members").insert({ org_id: org.id, user_id: target.id, role }),
      )
      return json(c, 201, { user_id: target.id, role })
    })),

    del("/orgs/:login/members/:username", authed(async (c) => {
      const userId = authId(c)
      const login = normalizeLogin(c.params.login)
      const targetLogin = normalizeLogin(c.params.username)
      const org = await db.one(
        from("orgs").where(q => q("login").equals(login)).select("id"),
      ) as { id: number } | null
      if (!org) return apiError(c, "not_found", "Org not found")
      const owner = await db.one(
        from("org_members")
          .where(q => q("org_id").equals(org.id))
          .where(q => q("user_id").equals(userId))
          .where(q => q("role").equals("owner"))
          .select("id"),
      )
      if (!owner) return apiError(c, "forbidden", "Only org owners can remove members")
      const target = await db.one(
        from("users").where(q => q("username").equals(targetLogin)).select("id"),
      ) as { id: number } | null
      if (!target) return apiError(c, "not_found", "User not found")

      // Refuse to remove the last owner — leaves an org with no admin.
      const ownerCount = await db.one({
        text: "SELECT COUNT(*)::int AS n FROM org_members WHERE org_id = $1 AND role = 'owner'",
        values: [org.id],
      }) as { n: number } | null
      const targetMember = await db.one(
        from("org_members")
          .where(q => q("org_id").equals(org.id))
          .where(q => q("user_id").equals(target.id))
          .select("role"),
      ) as { role: string } | null
      if (targetMember?.role === "owner" && (ownerCount?.n ?? 0) <= 1) {
        return apiError(c, "validation", "Cannot remove the last org owner")
      }

      await db.execute(
        from("org_members")
          .where(q => q("org_id").equals(org.id))
          .where(q => q("user_id").equals(target.id))
          .del(),
      )
      return json(c, 200, { removed: target.id })
    })),
  ]
}
