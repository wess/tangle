import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { get, json, parseJson, patch, pipeline, post } from "@atlas/server"
import { requireAuth } from "../auth/guard.ts"
import { findRepo, resolveRepoAccess } from "../permissions/index.ts"
import { nextIssueNumber } from "../issues/index.ts"
import { renderMarkdown } from "../markdown/index.ts"
import { dispatchWebhook } from "../webhooks/dispatch.ts"
import { resolveRepoPath } from "../git/repo.ts"
import { diffBetween, fastForwardMerge, resolveBranchSha } from "../git/merge.ts"
import { paginate, parseCursor } from "../util/pagination.ts"
import { apiError } from "../util/errors.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

export const pullRoutes = (db: Connection, secret: string, repoDir: string) => {
  const guard = pipeline(requireAuth({ secret, db }))
  const authed = pipeline(requireAuth({ secret, db }), parseJson)

  return [
    get("/repos/:owner/:name/pulls", guard(async (c) => {
      const userId = authId(c)
      const repo = await findRepo(db, c.params.owner, c.params.name)
      if (!repo) return apiError(c, "not_found", "Repo not found")
      const access = await resolveRepoAccess(db, repo, userId)
      if (!access.read) return apiError(c, "not_found", "Repo not found")

      const url = new URL(c.request.url)
      const state = (url.searchParams.get("state") ?? "open").toLowerCase()
      const valid = state === "open" || state === "closed" || state === "merged" || state === "all"
      if (!valid) return apiError(c, "validation", "state must be open, closed, merged, or all")

      const { beforeId, limit } = parseCursor(c.request)
      let q = from("pulls")
        .where(qb => qb("repo_id").equals(repo.id))
        .select("id", "number", "title", "state", "user_id", "head_branch", "base_branch", "comment_count", "merged_at", "created_at", "updated_at")
        .orderBy("id", "DESC")
        .limit(limit + 1)
      if (state !== "all") q = q.where(qb => qb("state").equals(state))
      if (beforeId !== null) q = q.where(qb => qb("id").lessThan(beforeId))

      const rows = await db.all(q) as Array<{ id: number; number: number; title: string; state: string; user_id: number | null; head_branch: string; base_branch: string; comment_count: number; merged_at: string | null; created_at: string; updated_at: string }>
      return json(c, 200, paginate(rows, limit))
    })),

    post("/repos/:owner/:name/pulls", authed(async (c) => {
      const userId = authId(c)
      const repo = await findRepo(db, c.params.owner, c.params.name)
      if (!repo) return apiError(c, "not_found", "Repo not found")
      const access = await resolveRepoAccess(db, repo, userId)
      if (!access.read) return apiError(c, "not_found", "Repo not found")

      const body = c.body as {
        title?: string
        body?: string
        head?: string; head_branch?: string; headBranch?: string
        base?: string; base_branch?: string; baseBranch?: string
        head_repo_id?: number; headRepoId?: number
      }
      const title = body.title?.trim()
      const head = (body.head ?? body.head_branch ?? body.headBranch)?.trim()
      const base = (body.base ?? body.base_branch ?? body.baseBranch)?.trim() || repo.default_branch
      const headRepoId = body.head_repo_id ?? body.headRepoId ?? repo.id
      if (!title) return apiError(c, "validation", "title required")
      if (!head) return apiError(c, "validation", "head branch required")
      if (head === base && headRepoId === repo.id) {
        return apiError(c, "validation", "head and base cannot be the same branch on the same repo")
      }

      const number = await nextIssueNumber(db, repo.id)
      const inserted = await db.execute(
        from("pulls").insert({
          repo_id: repo.id,
          number,
          user_id: userId,
          title,
          body: body.body?.trim() || null,
          head_repo_id: headRepoId,
          head_branch: head,
          base_branch: base,
        }).returning("id", "number", "title", "body", "state", "user_id", "head_branch", "base_branch", "comment_count", "created_at", "updated_at"),
      ) as Array<{ id: number; number: number; title: string; body: string | null; state: string; head_branch: string; base_branch: string }>
      const pull = inserted[0]!
      dispatchWebhook(db, repo.id, "pull_request", {
        event: "pull_request",
        action: "opened",
        repository: { id: repo.id, owner: repo.owner_login, name: repo.name },
        pull_request: pull,
        sender: { id: userId },
      })
      return json(c, 201, pull)
    })),

    get("/repos/:owner/:name/pulls/:number", guard(async (c) => {
      const userId = authId(c)
      const repo = await findRepo(db, c.params.owner, c.params.name)
      if (!repo) return apiError(c, "not_found", "Repo not found")
      const access = await resolveRepoAccess(db, repo, userId)
      if (!access.read) return apiError(c, "not_found", "Repo not found")

      const pull = await db.one(
        from("pulls")
          .where(q => q("repo_id").equals(repo.id))
          .where(q => q("number").equals(Number(c.params.number)))
          .select(
            "id", "number", "title", "body", "state", "user_id",
            "head_repo_id", "head_branch", "base_branch",
            "merge_commit_sha", "merged_at", "merged_by",
            "closed_at", "closed_by", "comment_count",
            "created_at", "updated_at",
          ),
      ) as { body: string | null } & Record<string, unknown> | null
      if (!pull) return apiError(c, "not_found", "Pull request not found")
      return json(c, 200, { ...pull, body_html: renderMarkdown(pull.body) })
    })),

    patch("/repos/:owner/:name/pulls/:number", authed(async (c) => {
      const userId = authId(c)
      const repo = await findRepo(db, c.params.owner, c.params.name)
      if (!repo) return apiError(c, "not_found", "Repo not found")
      const access = await resolveRepoAccess(db, repo, userId)
      if (!access.read) return apiError(c, "not_found", "Repo not found")

      const pull = await db.one(
        from("pulls")
          .where(q => q("repo_id").equals(repo.id))
          .where(q => q("number").equals(Number(c.params.number)))
          .select("id", "user_id", "state"),
      ) as { id: number; user_id: number | null; state: string } | null
      if (!pull) return apiError(c, "not_found", "Pull request not found")

      const body = c.body as { title?: string; body?: string; state?: string }
      const isAuthor = pull.user_id === userId
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
        if (next !== "open" && next !== "closed") return apiError(c, "validation", "state must be open or closed (use POST /merge to merge)")
        updates.state = next
        if (next === "closed" && pull.state === "open") {
          updates.closed_at = raw("NOW()")
          updates.closed_by = userId
        }
        if (next === "open" && pull.state === "closed") {
          updates.closed_at = null
          updates.closed_by = null
        }
      }
      if (Object.keys(updates).length === 0) return apiError(c, "validation", "No fields to update")
      updates.updated_at = raw("NOW()")
      await db.execute(from("pulls").where(q => q("id").equals(pull.id)).update(updates))
      const fresh = await db.one(
        from("pulls").where(q => q("id").equals(pull.id))
          .select("id", "number", "title", "body", "state", "user_id", "head_branch", "base_branch", "merged_at", "closed_at", "comment_count", "created_at", "updated_at"),
      ) as Record<string, unknown> | null
      const action = body.state === "closed" && pull.state === "open" ? "closed"
        : body.state === "open" && pull.state === "closed" ? "reopened"
        : "edited"
      if (fresh) {
        dispatchWebhook(db, repo.id, "pull_request", {
          event: "pull_request",
          action,
          repository: { id: repo.id, owner: repo.owner_login, name: repo.name },
          pull_request: fresh,
          sender: { id: userId },
        })
      }
      return json(c, 200, fresh)
    })),

    // Unified diff between the PR's base and head. Cross-repo PRs
    // (head_repo_id != base.id) aren't supported here yet — the
    // response carries `cross_repo: true` so the SPA can route the user
    // to clone-and-diff locally instead.
    get("/repos/:owner/:name/pulls/:number/diff", guard(async (c) => {
      const userId = authId(c)
      const repo = await findRepo(db, c.params.owner, c.params.name)
      if (!repo) return apiError(c, "not_found", "Repo not found")
      const access = await resolveRepoAccess(db, repo, userId)
      if (!access.read) return apiError(c, "not_found", "Repo not found")

      const pull = await db.one(
        from("pulls")
          .where(q => q("repo_id").equals(repo.id))
          .where(q => q("number").equals(Number(c.params.number)))
          .select("id", "head_repo_id", "head_branch", "base_branch"),
      ) as { id: number; head_repo_id: number | null; head_branch: string; base_branch: string } | null
      if (!pull) return apiError(c, "not_found", "Pull request not found")
      if (pull.head_repo_id && pull.head_repo_id !== repo.id) {
        return json(c, 200, { cross_repo: true, head_repo_id: pull.head_repo_id, base: pull.base_branch, head: pull.head_branch })
      }

      const gitdir = resolveRepoPath(repoDir, repo.owner_login, repo.name)
      const [baseSha, headSha] = await Promise.all([
        resolveBranchSha(gitdir, pull.base_branch),
        resolveBranchSha(gitdir, pull.head_branch),
      ])
      if (!baseSha || !headSha) {
        return apiError(c, "conflict", "Base or head branch is missing — has it been deleted since the PR was opened?")
      }
      const diff = await diffBetween(gitdir, baseSha, headSha)
      if (!diff) return apiError(c, "internal", "Failed to compute diff")
      return json(c, 200, { ...diff, base_branch: pull.base_branch, head_branch: pull.head_branch })
    })),

    // Fast-forward merge. Refuses if FF isn't possible — caller can
    // rebase or merge locally and push, then close the PR. Records
    // merge_commit_sha + merged_at + merged_by, fires the
    // `pull_request` webhook with `action: merged`.
    post("/repos/:owner/:name/pulls/:number/merge", authed(async (c) => {
      const userId = authId(c)
      const repo = await findRepo(db, c.params.owner, c.params.name)
      if (!repo) return apiError(c, "not_found", "Repo not found")
      const access = await resolveRepoAccess(db, repo, userId)
      if (!access.write) return apiError(c, "forbidden", "Repo writer access required")

      const pull = await db.one(
        from("pulls")
          .where(q => q("repo_id").equals(repo.id))
          .where(q => q("number").equals(Number(c.params.number)))
          .select("id", "state", "head_repo_id", "head_branch", "base_branch", "merged_at"),
      ) as {
        id: number; state: string; head_repo_id: number | null
        head_branch: string; base_branch: string; merged_at: string | null
      } | null
      if (!pull) return apiError(c, "not_found", "Pull request not found")
      if (pull.merged_at) return apiError(c, "conflict", "Already merged")
      if (pull.state !== "open") return apiError(c, "conflict", "Pull request is not open")
      if (pull.head_repo_id && pull.head_repo_id !== repo.id) {
        return apiError(c, "validation", "Cross-repo merges are not yet supported. Pull the head branch into this repo, then merge.")
      }

      const gitdir = resolveRepoPath(repoDir, repo.owner_login, repo.name)
      const headSha = await resolveBranchSha(gitdir, pull.head_branch)
      if (!headSha) return apiError(c, "conflict", "Head branch is missing — has it been deleted?")

      const result = await fastForwardMerge(gitdir, pull.base_branch, headSha)
      if (!result.ok) {
        if (result.reason === "not-ancestor") {
          return apiError(c, "not_ancestor", "Cannot fast-forward — base has diverged. Rebase the head branch onto the base, then push.")
        }
        if (result.reason === "missing-ref") {
          return apiError(c, "missing_ref", "Base branch is missing")
        }
        return apiError(c, "ref_update_failed", `Ref update failed: ${result.detail}`)
      }

      await db.execute(
        from("pulls").where(q => q("id").equals(pull.id)).update({
          state: "closed",
          merge_commit_sha: result.sha,
          merged_at: raw("NOW()"),
          merged_by: userId,
          closed_at: raw("NOW()"),
          closed_by: userId,
          updated_at: raw("NOW()"),
        }),
      )

      // Stamp pushed_at so the dashboard reflects the merge as activity.
      void db.execute(
        from("repos").where(q => q("id").equals(repo.id)).update({ pushed_at: raw("NOW()") }),
      ).catch(() => {})

      dispatchWebhook(db, repo.id, "pull_request", {
        event: "pull_request",
        action: "merged",
        repository: { id: repo.id, owner: repo.owner_login, name: repo.name },
        pull_request: { ...pull, merge_commit_sha: result.sha, state: "closed" },
        sender: { id: userId },
      })
      // Push event too — the merged ref move is a push from the
      // receiver's perspective.
      dispatchWebhook(db, repo.id, "push", {
        event: "push",
        repository: { id: repo.id, owner: repo.owner_login, name: repo.name },
        ref: `refs/heads/${pull.base_branch}`,
        after: result.sha,
        pushed_by: { id: userId },
        pushed_at: new Date().toISOString(),
        via: "pr-merge",
      })

      return json(c, 200, {
        merged: true,
        mode: result.mode,
        sha: result.sha,
        base_branch: pull.base_branch,
      })
    })),
  ]
}
