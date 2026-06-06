import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { get, json, parseJson, pipeline, post } from "@atlas/server"
import { requireAuth } from "../auth/guard.ts"
import { findRepo, resolveRepoAccess } from "../permissions/index.ts"
import { dispatchWebhook } from "../webhooks/dispatch.ts"
import { apiError } from "../util/errors.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

export const STATES = ["pending", "success", "failure", "error"] as const
export type State = (typeof STATES)[number]

const SHA_RE = /^[0-9a-f]{7,64}$/
const CONTEXT_RE = /^[\w./:-]{1,255}$/

// Roll a set of per-context states into a single combined state, GitHub-style:
// any failure/error → failure, else any pending (or none) → pending, else success.
export const combinedState = (states: readonly string[]): State => {
  if (states.some((s) => s === "failure" || s === "error")) return "failure"
  if (states.length === 0 || states.some((s) => s === "pending")) return "pending"
  return "success"
}

type StatusRow = {
  id: number
  sha: string
  state: string
  context: string
  description: string | null
  target_url: string | null
  creator_id: number | null
  created_at: string
  updated_at: string
}

const isHttpUrl = (url: string): boolean => {
  try {
    const u = new URL(url)
    return u.protocol === "https:" || u.protocol === "http:"
  } catch {
    return false
  }
}

export const statusRoutes = (db: Connection, secret: string) => {
  const guard = pipeline(requireAuth({ secret, db }))
  const authed = pipeline(requireAuth({ secret, db }), parseJson)

  const loadStatuses = (repoId: number, sha: string) =>
    db.all(
      from("commit_statuses")
        .where((q) => q("repo_id").equals(repoId))
        .where((q) => q("sha").equals(sha))
        .select("id", "sha", "state", "context", "description", "target_url", "creator_id", "created_at", "updated_at")
        .orderBy("updated_at", "DESC"),
    ) as Promise<StatusRow[]>

  return [
    // Create or update the status for a (sha, context). Writers only.
    post("/repos/:owner/:name/statuses/:sha", authed(async (c) => {
      const userId = authId(c)
      const repo = await findRepo(db, c.params.owner, c.params.name)
      if (!repo) return apiError(c, "not_found", "Repo not found")
      const access = await resolveRepoAccess(db, repo, userId)
      if (!access.write) return apiError(c, "forbidden", "Repo writer access required")

      const sha = String(c.params.sha).toLowerCase()
      if (!SHA_RE.test(sha)) return apiError(c, "validation", "Invalid commit sha")

      const body = c.body as {
        state?: string
        context?: string
        description?: string
        target_url?: string
        targetUrl?: string
      }
      const state = body.state?.trim()
      if (!state || !STATES.includes(state as State)) {
        return apiError(c, "validation", `state must be one of ${STATES.join(", ")}`)
      }
      const context = body.context?.trim() || "default"
      if (!CONTEXT_RE.test(context)) return apiError(c, "validation", "Invalid context")
      const description = body.description?.trim()?.slice(0, 1024) || null
      const targetUrl = (body.target_url ?? body.targetUrl)?.trim() || null
      if (targetUrl && !isHttpUrl(targetUrl)) return apiError(c, "validation", "target_url must be http(s)")

      // Latest-per-context: update in place when the context already exists.
      const existing = await db.one(
        from("commit_statuses")
          .where((q) => q("repo_id").equals(repo.id))
          .where((q) => q("sha").equals(sha))
          .where((q) => q("context").equals(context))
          .select("id"),
      ) as { id: number } | null

      let row: StatusRow
      if (existing) {
        const updated = await db.execute(
          from("commit_statuses")
            .where((q) => q("id").equals(existing.id))
            .update({ state, description, target_url: targetUrl, creator_id: userId, updated_at: raw("NOW()") })
            .returning("id", "sha", "state", "context", "description", "target_url", "creator_id", "created_at", "updated_at"),
        ) as StatusRow[]
        row = updated[0]!
      } else {
        const inserted = await db.execute(
          from("commit_statuses")
            .insert({ repo_id: repo.id, sha, state, context, description, target_url: targetUrl, creator_id: userId })
            .returning("id", "sha", "state", "context", "description", "target_url", "creator_id", "created_at", "updated_at"),
        ) as StatusRow[]
        row = inserted[0]!
      }

      dispatchWebhook(db, repo.id, "status", {
        event: "status",
        sha,
        state,
        context,
        description,
        target_url: targetUrl,
        repository: { id: repo.id, owner: repo.owner_login, name: repo.name },
        sender: { id: userId },
      })

      return json(c, 201, row)
    })),

    // Individual statuses for a commit (latest per context).
    get("/repos/:owner/:name/commits/:sha/statuses", guard(async (c) => {
      const userId = authId(c)
      const repo = await findRepo(db, c.params.owner, c.params.name)
      if (!repo) return apiError(c, "not_found", "Repo not found")
      const access = await resolveRepoAccess(db, repo, userId)
      if (!access.read) return apiError(c, "not_found", "Repo not found")

      const sha = String(c.params.sha).toLowerCase()
      return json(c, 200, await loadStatuses(repo.id, sha))
    })),

    // Combined (rolled-up) status for a commit — the green/red signal.
    get("/repos/:owner/:name/commits/:sha/status", guard(async (c) => {
      const userId = authId(c)
      const repo = await findRepo(db, c.params.owner, c.params.name)
      if (!repo) return apiError(c, "not_found", "Repo not found")
      const access = await resolveRepoAccess(db, repo, userId)
      if (!access.read) return apiError(c, "not_found", "Repo not found")

      const sha = String(c.params.sha).toLowerCase()
      const statuses = await loadStatuses(repo.id, sha)
      return json(c, 200, {
        sha,
        state: combinedState(statuses.map((s) => s.state)),
        total_count: statuses.length,
        statuses,
      })
    })),
  ]
}
