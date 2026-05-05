import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { del, get, json, parseJson, patch, pipeline, post } from "@atlas/server"
import { requireAuth } from "../auth/guard.ts"
import { findRepo, resolveRepoAccess } from "../permissions/index.ts"
import { isEmail, normalizeLogin } from "../util/username.ts"
import { apiError } from "../util/errors.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

const VALID_ROLES = new Set(["reader", "writer", "admin"])

export const collaboratorRoutes = (db: Connection, secret: string) => {
  const guard = pipeline(requireAuth({ secret, db }))
  const authed = pipeline(requireAuth({ secret, db }), parseJson)

  return [
    get("/repos/:owner/:name/collaborators", guard(async (c) => {
      const userId = authId(c)
      const repo = await findRepo(db, c.params.owner, c.params.name)
      if (!repo) return apiError(c, "not_found", "Repo not found")
      const access = await resolveRepoAccess(db, repo, userId)
      if (!access.admin) return apiError(c, "forbidden", "Repo admin access required")
      const text = `
        SELECT c.id, c.role, c.email, c.created_at, c.accepted_at,
               u.id AS user_id, u.username, u.name, u.avatar_key
        FROM repo_collaborators c
        LEFT JOIN users u ON u.id = c.user_id
        WHERE c.repo_id = $1
        ORDER BY c.created_at ASC
      `
      const rows = await db.execute({ text, values: [repo.id] })
      return json(c, 200, rows)
    })),

    post("/repos/:owner/:name/collaborators", authed(async (c) => {
      const userId = authId(c)
      const repo = await findRepo(db, c.params.owner, c.params.name)
      if (!repo) return apiError(c, "not_found", "Repo not found")
      const access = await resolveRepoAccess(db, repo, userId)
      if (!access.admin) return apiError(c, "forbidden", "Repo admin access required")

      const body = c.body as { username?: string; email?: string; role?: string }
      const role = (body.role ?? "reader").trim()
      if (!VALID_ROLES.has(role)) return apiError(c, "validation", `role must be one of ${[...VALID_ROLES].join(", ")}`)

      // Two ways to invite: by username (resolves to a user_id today) or
      // by email (recorded as a pending invite). Email-only collaborators
      // get hydrated when the invitee signs up.
      const username = body.username ? normalizeLogin(body.username) : ""
      const email = body.email?.trim().toLowerCase()
      if (!username && !email) return apiError(c, "validation", "username or email required")
      if (username && email) return apiError(c, "validation", "provide username OR email, not both")
      if (email && !isEmail(email)) return apiError(c, "validation", "Invalid email")

      if (username) {
        const target = await db.one(
          from("users").where(q => q("username").equals(username)).select("id"),
        ) as { id: number } | null
        if (!target) return apiError(c, "not_found", "User not found")

        const dup = await db.one(
          from("repo_collaborators")
            .where(q => q("repo_id").equals(repo.id))
            .where(q => q("user_id").equals(target.id))
            .select("id"),
        )
        if (dup) return apiError(c, "conflict", "User is already a collaborator")

        const inserted = await db.execute(
          from("repo_collaborators").insert({
            repo_id: repo.id,
            user_id: target.id,
            role,
            invited_by: userId,
            accepted_at: raw("NOW()"),
          }).returning("id", "role", "user_id", "created_at", "accepted_at"),
        ) as Array<unknown>
        return json(c, 201, inserted[0])
      }

      // Email path — pending invite. Don't dedupe across distinct
      // emails; do dedupe the same email + repo pair.
      const dup = await db.one(
        from("repo_collaborators")
          .where(q => q("repo_id").equals(repo.id))
          .where(q => q("email").ilike(email!))
          .select("id"),
      )
      if (dup) return apiError(c, "conflict", "An invite for that email already exists")
      const inserted = await db.execute(
        from("repo_collaborators").insert({
          repo_id: repo.id,
          email,
          role,
          invited_by: userId,
        }).returning("id", "role", "email", "created_at"),
      ) as Array<unknown>
      return json(c, 201, inserted[0])
    })),

    patch("/repos/:owner/:name/collaborators/:id", authed(async (c) => {
      const userId = authId(c)
      const repo = await findRepo(db, c.params.owner, c.params.name)
      if (!repo) return apiError(c, "not_found", "Repo not found")
      const access = await resolveRepoAccess(db, repo, userId)
      if (!access.admin) return apiError(c, "forbidden", "Repo admin access required")

      const id = Number(c.params.id)
      const collab = await db.one(
        from("repo_collaborators").where(q => q("id").equals(id)).where(q => q("repo_id").equals(repo.id)).select("id"),
      ) as { id: number } | null
      if (!collab) return apiError(c, "not_found", "Collaborator not found")

      const body = c.body as { role?: string }
      const role = body.role?.trim()
      if (!role || !VALID_ROLES.has(role)) return apiError(c, "validation", `role must be one of ${[...VALID_ROLES].join(", ")}`)
      await db.execute(from("repo_collaborators").where(q => q("id").equals(collab.id)).update({ role }))
      return json(c, 200, { id: collab.id, role })
    })),

    del("/repos/:owner/:name/collaborators/:id", guard(async (c) => {
      const userId = authId(c)
      const repo = await findRepo(db, c.params.owner, c.params.name)
      if (!repo) return apiError(c, "not_found", "Repo not found")
      const access = await resolveRepoAccess(db, repo, userId)
      if (!access.admin) return apiError(c, "forbidden", "Repo admin access required")

      const id = Number(c.params.id)
      const removed = await db.execute(
        from("repo_collaborators").where(q => q("id").equals(id)).where(q => q("repo_id").equals(repo.id)).del().returning("id"),
      ) as Array<{ id: number }>
      if (removed.length === 0) return apiError(c, "not_found", "Collaborator not found")
      return json(c, 200, { removed: id })
    })),
  ]
}
