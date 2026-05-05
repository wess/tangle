import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { del, get, json, pipeline, post } from "@atlas/server"
import { requireAuth } from "../auth/guard.ts"
import { findRepo, resolveRepoAccess } from "../permissions/index.ts"
import { dispatchWebhook } from "../webhooks/dispatch.ts"
import { apiError } from "../util/errors.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

export const starRoutes = (db: Connection, secret: string) => {
  const guard = pipeline(requireAuth({ secret, db }))

  return [
    get("/me/stars", guard(async (c) => {
      const userId = authId(c)
      const text = `
        SELECT r.id, r.owner_login, r.name, r.description, r.is_private,
               r.star_count, r.pushed_at, s.created_at AS starred_at
        FROM stars s
        JOIN repos r ON r.id = s.repo_id
        WHERE s.user_id = $1 AND r.deleted_at IS NULL
          AND (
            r.is_private = false
            OR (r.owner_kind = 'user' AND r.owner_id = $1)
            OR (r.owner_kind = 'org' AND r.owner_id IN (
              SELECT org_id FROM org_members WHERE user_id = $1
            ))
            OR EXISTS (SELECT 1 FROM repo_collaborators c WHERE c.repo_id = r.id AND c.user_id = $1)
          )
        ORDER BY s.created_at DESC
        LIMIT 200
      `
      const rows = await db.execute({ text, values: [userId] })
      return json(c, 200, rows)
    })),

    post("/repos/:owner/:name/star", guard(async (c) => {
      const userId = authId(c)
      const repo = await findRepo(db, c.params.owner, c.params.name)
      if (!repo) return apiError(c, "not_found", "Repo not found")
      const access = await resolveRepoAccess(db, repo, userId)
      if (!access.read) return apiError(c, "not_found", "Repo not found")

      const existing = await db.one(
        from("stars").where(q => q("user_id").equals(userId)).where(q => q("repo_id").equals(repo.id)).select("id"),
      )
      if (existing) return json(c, 200, { starred: true, star_count: undefined })

      await db.execute(from("stars").insert({ user_id: userId, repo_id: repo.id }))
      // Atomic increment; the read-modify-write would race under
      // concurrent stars from the same user (which the unique index
      // already blocks) but also from the rare case of two distinct
      // users hitting the endpoint at once.
      await db.execute(
        from("repos").where(q => q("id").equals(repo.id)).update({ star_count: raw("star_count + 1") }),
      )
      const fresh = await db.one(
        from("repos").where(q => q("id").equals(repo.id)).select("star_count"),
      ) as { star_count: number } | null
      dispatchWebhook(db, repo.id, "star", {
        event: "star",
        action: "created",
        repository: { id: repo.id, owner: repo.owner_login, name: repo.name },
        sender: { id: userId },
        star_count: fresh?.star_count ?? 0,
      })
      return json(c, 200, { starred: true, star_count: fresh?.star_count ?? 0 })
    })),

    del("/repos/:owner/:name/star", guard(async (c) => {
      const userId = authId(c)
      const repo = await findRepo(db, c.params.owner, c.params.name)
      if (!repo) return apiError(c, "not_found", "Repo not found")

      const removed = await db.execute(
        from("stars").where(q => q("user_id").equals(userId)).where(q => q("repo_id").equals(repo.id)).del().returning("id"),
      ) as Array<{ id: number }>
      if (removed.length > 0) {
        await db.execute(
          from("repos").where(q => q("id").equals(repo.id)).update({ star_count: raw("GREATEST(star_count - 1, 0)") }),
        )
      }
      const fresh = await db.one(
        from("repos").where(q => q("id").equals(repo.id)).select("star_count"),
      ) as { star_count: number } | null
      return json(c, 200, { starred: false, star_count: fresh?.star_count ?? 0 })
    })),
  ]
}
