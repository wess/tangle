import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { del, get, json, parseJson, patch, pipeline, post } from "@atlas/server"
import { requireAuth } from "../auth/guard.ts"
import { findRepo, resolveRepoAccess } from "../permissions/index.ts"
import { apiError } from "../util/errors.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

const HEX_COLOR_RE = /^[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/

const cleanColor = (raw: string): string | null => {
  const trimmed = raw.trim().replace(/^#/, "").toUpperCase()
  return HEX_COLOR_RE.test(trimmed) ? trimmed : null
}

export const labelRoutes = (db: Connection, secret: string) => {
  const guard = pipeline(requireAuth({ secret, db }))
  const authed = pipeline(requireAuth({ secret, db }), parseJson)

  return [
    get("/repos/:owner/:name/labels", guard(async (c) => {
      const userId = authId(c)
      const repo = await findRepo(db, c.params.owner, c.params.name)
      if (!repo) return apiError(c, "not_found", "Repo not found")
      const access = await resolveRepoAccess(db, repo, userId)
      if (!access.read) return apiError(c, "not_found", "Repo not found")
      const rows = await db.all(
        from("labels").where(q => q("repo_id").equals(repo.id))
          .select("id", "name", "color", "description", "created_at")
          .orderBy("name", "ASC"),
      )
      return json(c, 200, rows)
    })),

    post("/repos/:owner/:name/labels", authed(async (c) => {
      const userId = authId(c)
      const repo = await findRepo(db, c.params.owner, c.params.name)
      if (!repo) return apiError(c, "not_found", "Repo not found")
      const access = await resolveRepoAccess(db, repo, userId)
      if (!access.write) return apiError(c, "forbidden", "Repo writer access required")

      const body = c.body as { name?: string; color?: string; description?: string }
      const name = body.name?.trim()
      if (!name) return apiError(c, "validation", "name required")
      if (name.length > 64) return apiError(c, "validation", "name too long")

      // Default to the brand frost colour so labels are pleasant out
      // of the box even when the caller doesn't pick.
      const color = body.color ? cleanColor(body.color) : "5E81AC"
      if (color === null) return apiError(c, "validation", "color must be a 3- or 6-digit hex")

      const dup = await db.one(
        from("labels").where(q => q("repo_id").equals(repo.id)).where(q => q("name").equals(name)).select("id"),
      )
      if (dup) return apiError(c, "conflict", "A label with that name already exists")

      const inserted = await db.execute(
        from("labels").insert({
          repo_id: repo.id,
          name,
          color,
          description: body.description?.trim() || null,
        }).returning("id", "name", "color", "description", "created_at"),
      ) as Array<unknown>
      return json(c, 201, inserted[0])
    })),

    patch("/repos/:owner/:name/labels/:id", authed(async (c) => {
      const userId = authId(c)
      const repo = await findRepo(db, c.params.owner, c.params.name)
      if (!repo) return apiError(c, "not_found", "Repo not found")
      const access = await resolveRepoAccess(db, repo, userId)
      if (!access.write) return apiError(c, "forbidden", "Repo writer access required")

      const id = Number(c.params.id)
      const label = await db.one(
        from("labels").where(q => q("id").equals(id)).where(q => q("repo_id").equals(repo.id)).select("id"),
      ) as { id: number } | null
      if (!label) return apiError(c, "not_found", "Label not found")

      const body = c.body as { name?: string; color?: string; description?: string }
      const updates: Record<string, unknown> = {}
      if (body.name !== undefined) {
        const n = body.name.trim()
        if (!n) return apiError(c, "validation", "name cannot be empty")
        updates.name = n
      }
      if (body.color !== undefined) {
        const cc = cleanColor(body.color)
        if (cc === null) return apiError(c, "validation", "color must be a 3- or 6-digit hex")
        updates.color = cc
      }
      if (body.description !== undefined) updates.description = body.description.trim() || null
      if (Object.keys(updates).length === 0) return apiError(c, "validation", "No fields to update")

      await db.execute(from("labels").where(q => q("id").equals(label.id)).update(updates))
      const fresh = await db.one(
        from("labels").where(q => q("id").equals(label.id)).select("id", "name", "color", "description", "created_at"),
      )
      return json(c, 200, fresh)
    })),

    del("/repos/:owner/:name/labels/:id", guard(async (c) => {
      const userId = authId(c)
      const repo = await findRepo(db, c.params.owner, c.params.name)
      if (!repo) return apiError(c, "not_found", "Repo not found")
      const access = await resolveRepoAccess(db, repo, userId)
      if (!access.write) return apiError(c, "forbidden", "Repo writer access required")
      const id = Number(c.params.id)
      const removed = await db.execute(
        from("labels").where(q => q("id").equals(id)).where(q => q("repo_id").equals(repo.id)).del().returning("id"),
      ) as Array<{ id: number }>
      if (removed.length === 0) return apiError(c, "not_found", "Label not found")
      return json(c, 200, { deleted: id })
    })),

    // Apply / remove labels on issues + pulls. We accept the subject
    // number (the user-facing identifier) and resolve to the canonical
    // id internally.
    post("/repos/:owner/:name/:kind/:number/labels", authed(async (c) => {
      const userId = authId(c)
      const kind = c.params.kind === "issues" ? "issue"
        : c.params.kind === "pulls" ? "pull"
        : null
      if (!kind) return apiError(c, "not_found", "Unsupported subject kind")

      const repo = await findRepo(db, c.params.owner, c.params.name)
      if (!repo) return apiError(c, "not_found", "Repo not found")
      const access = await resolveRepoAccess(db, repo, userId)
      if (!access.write) return apiError(c, "forbidden", "Repo writer access required")

      const table = kind === "issue" ? "issues" : "pulls"
      const subject = await db.one(
        from(table).where(q => q("repo_id").equals(repo.id)).where(q => q("number").equals(Number(c.params.number))).select("id"),
      ) as { id: number } | null
      if (!subject) return apiError(c, "not_found", "Subject not found")

      const body = c.body as { labels?: number[] }
      const labelIds = (body.labels ?? []).map(Number).filter(Number.isFinite)
      if (labelIds.length === 0) return apiError(c, "validation", "labels: array of label ids required")

      // Filter to only labels owned by this repo — silently drop
      // mismatches rather than failing the whole batch on one bad id.
      const valid = await db.all(
        from("labels")
          .where(q => q("repo_id").equals(repo.id))
          .where(q => q("id").inList(labelIds))
          .select("id"),
      ) as Array<{ id: number }>
      for (const l of valid) {
        await db.execute(
          from("label_assignments").insert({
            label_id: l.id,
            subject_kind: kind,
            subject_id: subject.id,
          }),
        ).catch(() => { /* duplicates ok */ })
      }
      const rows = await db.all(
        from("labels")
          .where(q => q("repo_id").equals(repo.id))
          .select("id", "name", "color", "description"),
      )
      return json(c, 200, rows)
    })),

    del("/repos/:owner/:name/:kind/:number/labels/:label_id", guard(async (c) => {
      const userId = authId(c)
      const kind = c.params.kind === "issues" ? "issue"
        : c.params.kind === "pulls" ? "pull"
        : null
      if (!kind) return apiError(c, "not_found", "Unsupported subject kind")

      const repo = await findRepo(db, c.params.owner, c.params.name)
      if (!repo) return apiError(c, "not_found", "Repo not found")
      const access = await resolveRepoAccess(db, repo, userId)
      if (!access.write) return apiError(c, "forbidden", "Repo writer access required")

      const table = kind === "issue" ? "issues" : "pulls"
      const subject = await db.one(
        from(table).where(q => q("repo_id").equals(repo.id)).where(q => q("number").equals(Number(c.params.number))).select("id"),
      ) as { id: number } | null
      if (!subject) return apiError(c, "not_found", "Subject not found")

      await db.execute(
        from("label_assignments")
          .where(q => q("subject_kind").equals(kind))
          .where(q => q("subject_id").equals(subject.id))
          .where(q => q("label_id").equals(Number(c.params.label_id)))
          .del(),
      )
      return json(c, 200, { ok: true })
    })),
  ]
}
