import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { get, json, parseJson, patch, pipeline, post } from "@atlas/server"
import { requireAuth } from "../auth/guard.ts"
import { findRepo, resolveRepoAccess } from "../permissions/index.ts"
import { renderMarkdown } from "../markdown/index.ts"
import { dispatchWebhook } from "../webhooks/dispatch.ts"
import { paginate, parseCursor } from "../util/pagination.ts"
import { apiError } from "../util/errors.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

// Allocate the next per-repo issue number. Issues and pulls share a
// numbering pool to mirror the GitHub UX — `#42` is unambiguous within
// a repo regardless of whether it's an issue or a PR.
export const nextIssueNumber = async (db: Connection, repoId: number): Promise<number> => {
  const text = `
    SELECT COALESCE(MAX(n), 0) + 1 AS next FROM (
      SELECT number AS n FROM issues WHERE repo_id = $1
      UNION ALL
      SELECT number AS n FROM pulls WHERE repo_id = $1
    ) s
  `
  const row = await db.one({ text, values: [repoId] }) as { next: number } | null
  return row?.next ?? 1
}

export const issueRoutes = (db: Connection, secret: string) => {
  const guard = pipeline(requireAuth({ secret, db }))
  const authed = pipeline(requireAuth({ secret, db }), parseJson)

  return [
    get("/repos/:owner/:name/issues", guard(async (c) => {
      const userId = authId(c)
      const repo = await findRepo(db, c.params.owner, c.params.name)
      if (!repo) return apiError(c, "not_found", "Repo not found")
      const access = await resolveRepoAccess(db, repo, userId)
      if (!access.read) return apiError(c, "not_found", "Repo not found")

      const url = new URL(c.request.url)
      const state = (url.searchParams.get("state") ?? "open").toLowerCase()
      const valid = state === "open" || state === "closed" || state === "all"
      if (!valid) return apiError(c, "validation", "state must be open, closed, or all")

      const { beforeId, limit } = parseCursor(c.request)
      let q = from("issues")
        .where(qb => qb("repo_id").equals(repo.id))
        .select("id", "number", "title", "state", "user_id", "comment_count", "created_at", "updated_at", "closed_at")
        .orderBy("id", "DESC")
        // Fetch one extra row so paginate() can decide whether a next
        // cursor is warranted without a separate COUNT query.
        .limit(limit + 1)
      if (state !== "all") q = q.where(qb => qb("state").equals(state))
      if (beforeId !== null) q = q.where(qb => qb("id").lessThan(beforeId))

      const rows = await db.all(q) as Array<{ id: number; number: number; title: string; state: string; user_id: number | null; comment_count: number; created_at: string; updated_at: string; closed_at: string | null }>
      return json(c, 200, paginate(rows, limit))
    })),

    post("/repos/:owner/:name/issues", authed(async (c) => {
      const userId = authId(c)
      const repo = await findRepo(db, c.params.owner, c.params.name)
      if (!repo) return apiError(c, "not_found", "Repo not found")
      const access = await resolveRepoAccess(db, repo, userId)
      if (!access.read) return apiError(c, "not_found", "Repo not found")
      // Public repos: anyone authenticated can open issues. Private:
      // collaborators / org members only — same gate as `read` access.

      const body = c.body as { title?: string; body?: string }
      const title = body.title?.trim()
      if (!title) return apiError(c, "validation", "title required")
      if (title.length > 256) return apiError(c, "validation", "title is too long (max 256 chars)")

      const number = await nextIssueNumber(db, repo.id)
      const inserted = await db.execute(
        from("issues").insert({
          repo_id: repo.id,
          number,
          user_id: userId,
          title,
          body: body.body?.trim() || null,
        }).returning("id", "number", "title", "body", "state", "user_id", "comment_count", "created_at", "updated_at"),
      ) as Array<{ id: number; number: number; title: string; body: string | null; state: string }>
      const issue = inserted[0]!
      dispatchWebhook(db, repo.id, "issues", {
        event: "issues",
        action: "opened",
        repository: { id: repo.id, owner: repo.owner_login, name: repo.name },
        issue,
        sender: { id: userId },
      })
      return json(c, 201, issue)
    })),

    get("/repos/:owner/:name/issues/:number", guard(async (c) => {
      const userId = authId(c)
      const repo = await findRepo(db, c.params.owner, c.params.name)
      if (!repo) return apiError(c, "not_found", "Repo not found")
      const access = await resolveRepoAccess(db, repo, userId)
      if (!access.read) return apiError(c, "not_found", "Repo not found")

      const issue = await db.one(
        from("issues")
          .where(q => q("repo_id").equals(repo.id))
          .where(q => q("number").equals(Number(c.params.number)))
          .select("id", "number", "title", "body", "state", "user_id", "comment_count", "created_at", "updated_at", "closed_at"),
      ) as { body: string | null } & Record<string, unknown> | null
      if (!issue) return apiError(c, "not_found", "Issue not found")
      return json(c, 200, { ...issue, body_html: renderMarkdown(issue.body) })
    })),

    patch("/repos/:owner/:name/issues/:number", authed(async (c) => {
      const userId = authId(c)
      const repo = await findRepo(db, c.params.owner, c.params.name)
      if (!repo) return apiError(c, "not_found", "Repo not found")
      const access = await resolveRepoAccess(db, repo, userId)
      if (!access.read) return apiError(c, "not_found", "Repo not found")

      const issue = await db.one(
        from("issues")
          .where(q => q("repo_id").equals(repo.id))
          .where(q => q("number").equals(Number(c.params.number)))
          .select("id", "user_id", "state"),
      ) as { id: number; user_id: number | null; state: string } | null
      if (!issue) return apiError(c, "not_found", "Issue not found")

      const body = c.body as { title?: string; body?: string; state?: string }
      const isAuthor = issue.user_id === userId
      // Editing the title/body is author-or-writer. Closing/reopening
      // requires write access on the repo.
      const updates: Record<string, unknown> = {}
      if (body.title !== undefined) {
        if (!isAuthor && !access.write) return apiError(c, "forbidden", "Only the author or repo writers can edit")
        const t = body.title.trim()
        if (!t) return apiError(c, "validation", "title cannot be empty")
        updates.title = t
      }
      if (body.body !== undefined) {
        if (!isAuthor && !access.write) return apiError(c, "forbidden", "Only the author or repo writers can edit")
        updates.body = body.body.trim() || null
      }
      if (body.state !== undefined) {
        if (!access.write) return apiError(c, "forbidden", "Repo writer access required")
        const next = body.state.toLowerCase()
        if (next !== "open" && next !== "closed") return apiError(c, "validation", "state must be open or closed")
        updates.state = next
        if (next === "closed" && issue.state === "open") {
          updates.closed_at = raw("NOW()")
          updates.closed_by = userId
        }
        if (next === "open" && issue.state === "closed") {
          updates.closed_at = null
          updates.closed_by = null
        }
      }
      if (Object.keys(updates).length === 0) return apiError(c, "validation", "No fields to update")
      updates.updated_at = raw("NOW()")
      await db.execute(from("issues").where(q => q("id").equals(issue.id)).update(updates))
      const fresh = await db.one(
        from("issues").where(q => q("id").equals(issue.id))
          .select("id", "number", "title", "body", "state", "user_id", "comment_count", "created_at", "updated_at", "closed_at"),
      ) as { id: number; number: number; title: string; state: string } & Record<string, unknown> | null

      // Action ladder: closed/reopened are the headline transitions;
      // everything else (title/body edits) is "edited". Receivers can
      // filter on `action` without parsing the payload diff.
      const action = body.state === "closed" && issue.state === "open" ? "closed"
        : body.state === "open" && issue.state === "closed" ? "reopened"
        : "edited"
      if (fresh) {
        dispatchWebhook(db, repo.id, "issues", {
          event: "issues",
          action,
          repository: { id: repo.id, owner: repo.owner_login, name: repo.name },
          issue: fresh,
          sender: { id: userId },
        })
      }
      return json(c, 200, fresh)
    })),
  ]
}
