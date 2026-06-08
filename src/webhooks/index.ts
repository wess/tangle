import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { del, get, json, parseJson, patch, pipeline, post } from "@atlas/server"
import { requireAuth } from "../auth/guard.ts"
import { findRepo, resolveRepoAccess } from "../permissions/index.ts"
import { apiError } from "../util/errors.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

export const VALID_EVENTS = new Set(["push", "issues", "pull_request", "release", "star", "status"])
const validateEvents = (events: unknown): string[] | null => {
  if (!Array.isArray(events)) return null
  if (events.length === 0) return null
  const out: string[] = []
  for (const ev of events) {
    if (typeof ev !== "string" || !VALID_EVENTS.has(ev)) return null
    if (!out.includes(ev)) out.push(ev)
  }
  return out
}

const isHttpsOrLocal = (url: string): boolean => {
  try {
    const u = new URL(url)
    if (u.protocol === "https:") return true
    // Allow plain http for home-lab targets — most self-hosted webhook
    // consumers run on a private LAN. The admin can opt out by only
    // adding https URLs.
    if (u.protocol === "http:") return true
    return false
  } catch { return false }
}

export type WebhookRecord = {
  id: number
  url: string
  content_type: string
  events: string
  active: boolean
  created_at: string
}

export type CreateWebhookInput = {
  url?: string
  secret?: string | null
  content_type?: string
  contentType?: string
  events?: unknown
}

export type CreateWebhookResult =
  | { ok: true; webhook: WebhookRecord }
  | { ok: false; message: string }

// In-process webhook creation shared by the REST route and the MCP
// `tangle.webhooks.create` tool. Callers are responsible for resolving
// the repo and enforcing admin access first; this only validates the
// payload and inserts the row. Errors come back as a discriminated
// result so each transport can map them to its own envelope (apiError
// for REST, a thrown Error for MCP) without this module importing either.
export const createWebhook = async (
  db: Connection,
  repoId: number,
  createdBy: number,
  input: CreateWebhookInput,
): Promise<CreateWebhookResult> => {
  const url = input.url?.trim()
  if (!url || !isHttpsOrLocal(url)) return { ok: false, message: "url must be a valid http(s) URL" }
  const events = validateEvents(input.events)
  if (!events) {
    return { ok: false, message: `events must be a non-empty subset of [${[...VALID_EVENTS].join(", ")}]` }
  }
  const contentType = (input.content_type ?? input.contentType ?? "application/json").trim()
  if (contentType !== "application/json" && contentType !== "application/x-www-form-urlencoded") {
    return { ok: false, message: "content_type must be application/json or application/x-www-form-urlencoded" }
  }

  const inserted = await db.execute(
    from("webhooks").insert({
      repo_id: repoId,
      url,
      secret: input.secret?.trim() || null,
      content_type: contentType,
      events: JSON.stringify(events),
      active: true,
      created_by: createdBy,
    }).returning("id", "url", "content_type", "events", "active", "created_at"),
  ) as WebhookRecord[]
  return { ok: true, webhook: inserted[0] }
}

export const webhookRoutes = (db: Connection, secret: string) => {
  const guard = pipeline(requireAuth({ secret, db }))
  const authed = pipeline(requireAuth({ secret, db }), parseJson)

  return [
    get("/repos/:owner/:name/webhooks", guard(async (c) => {
      const userId = authId(c)
      const repo = await findRepo(db, c.params.owner, c.params.name)
      if (!repo) return apiError(c, "not_found", "Repo not found")
      const access = await resolveRepoAccess(db, repo, userId)
      if (!access.admin) return apiError(c, "forbidden", "Repo admin access required")

      const rows = await db.all(
        from("webhooks").where(q => q("repo_id").equals(repo.id))
          .select("id", "url", "content_type", "events", "active", "created_at")
          .orderBy("created_at", "DESC"),
      )
      return json(c, 200, rows)
    })),

    post("/repos/:owner/:name/webhooks", authed(async (c) => {
      const userId = authId(c)
      const repo = await findRepo(db, c.params.owner, c.params.name)
      if (!repo) return apiError(c, "not_found", "Repo not found")
      const access = await resolveRepoAccess(db, repo, userId)
      if (!access.admin) return apiError(c, "forbidden", "Repo admin access required")

      const body = c.body as CreateWebhookInput
      const result = await createWebhook(db, repo.id, userId, body)
      if (!result.ok) return apiError(c, "validation", result.message)
      return json(c, 201, result.webhook)
    })),

    patch("/repos/:owner/:name/webhooks/:id", authed(async (c) => {
      const userId = authId(c)
      const repo = await findRepo(db, c.params.owner, c.params.name)
      if (!repo) return apiError(c, "not_found", "Repo not found")
      const access = await resolveRepoAccess(db, repo, userId)
      if (!access.admin) return apiError(c, "forbidden", "Repo admin access required")

      const id = Number(c.params.id)
      const hook = await db.one(
        from("webhooks").where(q => q("id").equals(id)).where(q => q("repo_id").equals(repo.id)).select("id"),
      ) as { id: number } | null
      if (!hook) return apiError(c, "not_found", "Webhook not found")

      const body = c.body as { url?: string; secret?: string; content_type?: string; contentType?: string; events?: unknown; active?: boolean }
      const updates: Record<string, unknown> = {}
      if (body.url !== undefined) {
        if (!isHttpsOrLocal(body.url)) return apiError(c, "validation", "url must be a valid http(s) URL")
        updates.url = body.url.trim()
      }
      if (body.secret !== undefined) updates.secret = body.secret.trim() || null
      if (body.content_type !== undefined || body.contentType !== undefined) {
        const ct = (body.content_type ?? body.contentType ?? "").trim()
        if (ct !== "application/json" && ct !== "application/x-www-form-urlencoded") {
          return apiError(c, "validation", "content_type must be application/json or application/x-www-form-urlencoded")
        }
        updates.content_type = ct
      }
      if (body.events !== undefined) {
        const events = validateEvents(body.events)
        if (!events) return apiError(c, "validation", "events invalid")
        updates.events = JSON.stringify(events)
      }
      if (typeof body.active === "boolean") updates.active = body.active
      if (Object.keys(updates).length === 0) return apiError(c, "validation", "No fields to update")

      await db.execute(from("webhooks").where(q => q("id").equals(hook.id)).update(updates))
      const fresh = await db.one(
        from("webhooks").where(q => q("id").equals(hook.id))
          .select("id", "url", "content_type", "events", "active", "created_at"),
      )
      return json(c, 200, fresh)
    })),

    del("/repos/:owner/:name/webhooks/:id", guard(async (c) => {
      const userId = authId(c)
      const repo = await findRepo(db, c.params.owner, c.params.name)
      if (!repo) return apiError(c, "not_found", "Repo not found")
      const access = await resolveRepoAccess(db, repo, userId)
      if (!access.admin) return apiError(c, "forbidden", "Repo admin access required")

      const id = Number(c.params.id)
      const removed = await db.execute(
        from("webhooks").where(q => q("id").equals(id)).where(q => q("repo_id").equals(repo.id)).del().returning("id"),
      ) as Array<{ id: number }>
      if (removed.length === 0) return apiError(c, "not_found", "Webhook not found")
      return json(c, 200, { deleted: id })
    })),

    get("/repos/:owner/:name/webhooks/:id/deliveries", guard(async (c) => {
      const userId = authId(c)
      const repo = await findRepo(db, c.params.owner, c.params.name)
      if (!repo) return apiError(c, "not_found", "Repo not found")
      const access = await resolveRepoAccess(db, repo, userId)
      if (!access.admin) return apiError(c, "forbidden", "Repo admin access required")
      const id = Number(c.params.id)
      const hook = await db.one(
        from("webhooks").where(q => q("id").equals(id)).where(q => q("repo_id").equals(repo.id)).select("id"),
      )
      if (!hook) return apiError(c, "not_found", "Webhook not found")
      const rows = await db.all(
        from("webhook_deliveries").where(q => q("webhook_id").equals(id))
          .select("id", "event", "status_code", "duration_ms", "delivered_at")
          .orderBy("delivered_at", "DESC")
          .limit(50),
      )
      return json(c, 200, rows)
    })),
  ]
}
