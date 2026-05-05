import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { del, get, json, parseJson, patch, pipeline, post } from "@atlas/server"
import { requireAuth } from "../auth/guard.ts"
import { findRepo, resolveRepoAccess } from "../permissions/index.ts"
import { renderMarkdown } from "../markdown/index.ts"
import { apiError } from "../util/errors.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

const hydrateBody = <T extends { body: string }>(c: T): T & { body_html: string } => ({
  ...c,
  body_html: renderMarkdown(c.body),
})

type Subject = { kind: "issue" | "pull"; id: number }

const resolveSubject = async (
  db: Connection,
  repoId: number,
  kind: "issue" | "pull",
  number: number,
): Promise<Subject | null> => {
  const table = kind === "issue" ? "issues" : "pulls"
  const row = await db.one(
    from(table)
      .where(q => q("repo_id").equals(repoId))
      .where(q => q("number").equals(number))
      .select("id"),
  ) as { id: number } | null
  if (!row) return null
  return { kind, id: row.id }
}

// Mount under both `/issues/:n/comments` and `/pulls/:n/comments` so the
// URL is honest about which subject the comment belongs to. We funnel
// both through the same handler factory keyed on the subject kind.
const mountFor = (
  db: Connection,
  guard: ReturnType<typeof pipeline>,
  authed: ReturnType<typeof pipeline>,
  kind: "issue" | "pull",
) => {
  const subjectPath = kind === "issue" ? "issues" : "pulls"
  const subjectKind = kind

  return [
    get(`/repos/:owner/:name/${subjectPath}/:number/comments`, guard(async (c) => {
      const userId = authId(c)
      const repo = await findRepo(db, c.params.owner, c.params.name)
      if (!repo) return apiError(c, "not_found", "Repo not found")
      const access = await resolveRepoAccess(db, repo, userId)
      if (!access.read) return apiError(c, "not_found", "Repo not found")
      const subject = await resolveSubject(db, repo.id, kind, Number(c.params.number))
      if (!subject) return apiError(c, "not_found", `${kind === "issue" ? "Issue" : "Pull request"} not found`)

      const rows = await db.all(
        from("comments")
          .where(q => q("subject_kind").equals(subjectKind))
          .where(q => q("subject_id").equals(subject.id))
          .select("id", "user_id", "body", "edited_at", "created_at")
          .orderBy("created_at", "ASC"),
      ) as Array<{ id: number; user_id: number | null; body: string; edited_at: string | null; created_at: string }>
      return json(c, 200, rows.map(hydrateBody))
    })),

    post(`/repos/:owner/:name/${subjectPath}/:number/comments`, authed(async (c) => {
      const userId = authId(c)
      const repo = await findRepo(db, c.params.owner, c.params.name)
      if (!repo) return apiError(c, "not_found", "Repo not found")
      const access = await resolveRepoAccess(db, repo, userId)
      if (!access.read) return apiError(c, "not_found", "Repo not found")
      const subject = await resolveSubject(db, repo.id, kind, Number(c.params.number))
      if (!subject) return apiError(c, "not_found", `${kind === "issue" ? "Issue" : "Pull request"} not found`)

      const body = (c.body as { body?: string }).body?.trim()
      if (!body) return apiError(c, "validation", "body required")
      if (body.length > 65536) return apiError(c, "validation", "body too long")

      const inserted = await db.execute(
        from("comments").insert({
          subject_kind: subjectKind,
          subject_id: subject.id,
          user_id: userId,
          body,
        }).returning("id", "user_id", "body", "edited_at", "created_at"),
      ) as Array<{ id: number; user_id: number | null; body: string; edited_at: string | null; created_at: string }>

      // Bump the denormalized counter on the parent. Two writes cost a
      // round-trip but keep listing pages cheap (no SUM/COUNT joins).
      const parentTable = kind === "issue" ? "issues" : "pulls"
      void db.execute(
        from(parentTable).where(q => q("id").equals(subject.id)).update({
          comment_count: raw("comment_count + 1"),
          updated_at: raw("NOW()"),
        }),
      ).catch(() => {})
      return json(c, 201, hydrateBody(inserted[0]!))
    })),

    patch(`/repos/:owner/:name/${subjectPath}/:number/comments/:id`, authed(async (c) => {
      const userId = authId(c)
      const repo = await findRepo(db, c.params.owner, c.params.name)
      if (!repo) return apiError(c, "not_found", "Repo not found")
      const access = await resolveRepoAccess(db, repo, userId)
      if (!access.read) return apiError(c, "not_found", "Repo not found")

      const id = Number(c.params.id)
      const comment = await db.one(
        from("comments")
          .where(q => q("id").equals(id))
          .where(q => q("subject_kind").equals(subjectKind))
          .select("id", "subject_id", "user_id"),
      ) as { id: number; subject_id: number; user_id: number | null } | null
      if (!comment) return apiError(c, "not_found", "Comment not found")

      const isAuthor = comment.user_id === userId
      // Only the author can edit a comment. Repo admins can delete but
      // not silently rewrite — that would be a moderation footgun.
      if (!isAuthor) return apiError(c, "forbidden", "Only the author can edit a comment")

      const next = (c.body as { body?: string }).body?.trim()
      if (!next) return apiError(c, "validation", "body required")
      if (next.length > 65536) return apiError(c, "validation", "body too long")

      await db.execute(
        from("comments").where(q => q("id").equals(comment.id)).update({
          body: next,
          edited_at: raw("NOW()"),
        }),
      )
      const fresh = await db.one(
        from("comments").where(q => q("id").equals(comment.id)).select("id", "user_id", "body", "edited_at", "created_at"),
      ) as { id: number; user_id: number | null; body: string; edited_at: string | null; created_at: string } | null
      return json(c, 200, fresh ? hydrateBody(fresh) : null)
    })),

    del(`/repos/:owner/:name/${subjectPath}/:number/comments/:id`, authed(async (c) => {
      const userId = authId(c)
      const repo = await findRepo(db, c.params.owner, c.params.name)
      if (!repo) return apiError(c, "not_found", "Repo not found")
      const access = await resolveRepoAccess(db, repo, userId)
      if (!access.read) return apiError(c, "not_found", "Repo not found")

      const id = Number(c.params.id)
      const comment = await db.one(
        from("comments")
          .where(q => q("id").equals(id))
          .where(q => q("subject_kind").equals(subjectKind))
          .select("id", "subject_id", "user_id"),
      ) as { id: number; subject_id: number; user_id: number | null } | null
      if (!comment) return apiError(c, "not_found", "Comment not found")

      const isAuthor = comment.user_id === userId
      if (!isAuthor && !access.admin) {
        return apiError(c, "forbidden", "Only the author or a repo admin can delete a comment")
      }
      await db.execute(from("comments").where(q => q("id").equals(comment.id)).del())

      const parentTable = kind === "issue" ? "issues" : "pulls"
      void db.execute(
        from(parentTable).where(q => q("id").equals(comment.subject_id)).update({
          comment_count: raw("GREATEST(comment_count - 1, 0)"),
          updated_at: raw("NOW()"),
        }),
      ).catch(() => {})

      return json(c, 200, { deleted: id })
    })),
  ]
}

export const commentRoutes = (db: Connection, secret: string) => {
  const guard = pipeline(requireAuth({ secret, db }))
  const authed = pipeline(requireAuth({ secret, db }), parseJson)
  return [
    ...mountFor(db, guard, authed, "issue"),
    ...mountFor(db, guard, authed, "pull"),
  ]
}
