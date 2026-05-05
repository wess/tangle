import { from, raw } from "@atlas/db"
import { defineTool } from "@atlas/mcp"
import type { TangleMcpContext } from "../context.ts"
import { findRepo, resolveRepoAccess } from "../../permissions/index.ts"
import { renderMarkdown } from "../../markdown/index.ts"
import { dispatchWebhook } from "../../webhooks/dispatch.ts"
import { nextIssueNumber } from "../../issues/index.ts"

const requireUser = (ctx: TangleMcpContext): number => {
  if (ctx.userId === null) throw new Error("This tool requires authentication. Set TANGLE_MCP_USER.")
  return ctx.userId
}

export const issueTools = (ctx: TangleMcpContext) => [
  defineTool({
    name: "tangle.issues.list",
    description: "List issues for a repository. Filter by state (open/closed/all). Default: open.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        name: { type: "string" },
        state: { type: "string", enum: ["open", "closed", "all"] },
        limit: { type: "number" },
      },
      required: ["owner", "name"],
    },
    handler: async ({ owner, name, state, limit }: any) => {
      const repo = await findRepo(ctx.db, String(owner), String(name))
      if (!repo) throw new Error(`Repo ${owner}/${name} not found`)
      const access = await resolveRepoAccess(ctx.db, repo, ctx.userId)
      if (!access.read) throw new Error(`Repo ${owner}/${name} not found`)

      const s = (typeof state === "string" ? state : "open").toLowerCase()
      const lim = Math.min(Math.max(Number(limit ?? 50), 1), 200)
      let q = from("issues")
        .where(qb => qb("repo_id").equals(repo.id))
        .select("id", "number", "title", "state", "user_id", "comment_count", "created_at", "updated_at", "closed_at")
        .orderBy("id", "DESC")
        .limit(lim)
      if (s !== "all") q = q.where(qb => qb("state").equals(s))
      return await ctx.db.all(q)
    },
  }),

  defineTool({
    name: "tangle.issues.get",
    description: "Fetch one issue by number. Returns the rendered markdown body alongside the raw text.",
    inputSchema: {
      type: "object",
      properties: { owner: { type: "string" }, name: { type: "string" }, number: { type: "number" } },
      required: ["owner", "name", "number"],
    },
    handler: async ({ owner, name, number }: any) => {
      const repo = await findRepo(ctx.db, String(owner), String(name))
      if (!repo) throw new Error(`Repo ${owner}/${name} not found`)
      const access = await resolveRepoAccess(ctx.db, repo, ctx.userId)
      if (!access.read) throw new Error(`Repo ${owner}/${name} not found`)

      const issue = await ctx.db.one(
        from("issues")
          .where(q => q("repo_id").equals(repo.id))
          .where(q => q("number").equals(Number(number)))
          .select("id", "number", "title", "body", "state", "user_id", "comment_count", "created_at", "updated_at", "closed_at"),
      ) as { body: string | null } & Record<string, unknown> | null
      if (!issue) throw new Error("Issue not found")
      return { ...issue, body_html: renderMarkdown(issue.body) }
    },
  }),

  defineTool({
    name: "tangle.issues.create",
    description: "Open a new issue against a repository. Requires read access.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        name: { type: "string" },
        title: { type: "string" },
        body: { type: "string", description: "Markdown allowed." },
      },
      required: ["owner", "name", "title"],
    },
    handler: async ({ owner, name, title, body }: any) => {
      const userId = requireUser(ctx)
      const repo = await findRepo(ctx.db, String(owner), String(name))
      if (!repo) throw new Error(`Repo ${owner}/${name} not found`)
      const access = await resolveRepoAccess(ctx.db, repo, userId)
      if (!access.read) throw new Error(`Repo ${owner}/${name} not found`)
      const t = String(title ?? "").trim()
      if (!t) throw new Error("title required")
      if (t.length > 256) throw new Error("title too long")

      const number = await nextIssueNumber(ctx.db, repo.id)
      const inserted = await ctx.db.execute(
        from("issues").insert({
          repo_id: repo.id, number, user_id: userId, title: t,
          body: typeof body === "string" ? body.trim() || null : null,
        }).returning("id", "number", "title", "body", "state", "user_id", "created_at"),
      ) as Array<{ id: number; number: number; title: string; body: string | null; state: string }>
      const issue = inserted[0]!
      dispatchWebhook(ctx.db, repo.id, "issues", {
        event: "issues", action: "opened",
        repository: { id: repo.id, owner: repo.owner_login, name: repo.name },
        issue, sender: { id: userId },
      })
      return issue
    },
  }),

  defineTool({
    name: "tangle.issues.update",
    description: "Edit an issue's title/body, or close/reopen it. Title/body changes require author or repo writer access; state changes require writer.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        name: { type: "string" },
        number: { type: "number" },
        title: { type: "string" },
        body: { type: "string" },
        state: { type: "string", enum: ["open", "closed"] },
      },
      required: ["owner", "name", "number"],
    },
    handler: async ({ owner, name, number, title, body, state }: any) => {
      const userId = requireUser(ctx)
      const repo = await findRepo(ctx.db, String(owner), String(name))
      if (!repo) throw new Error(`Repo ${owner}/${name} not found`)
      const access = await resolveRepoAccess(ctx.db, repo, userId)
      if (!access.read) throw new Error(`Repo ${owner}/${name} not found`)

      const issue = await ctx.db.one(
        from("issues")
          .where(q => q("repo_id").equals(repo.id))
          .where(q => q("number").equals(Number(number)))
          .select("id", "user_id", "state"),
      ) as { id: number; user_id: number | null; state: string } | null
      if (!issue) throw new Error("Issue not found")

      const isAuthor = issue.user_id === userId
      const updates: Record<string, unknown> = {}
      if (typeof title === "string") {
        if (!isAuthor && !access.write) throw new Error("Only the author or repo writers can edit")
        const t = title.trim()
        if (!t) throw new Error("title cannot be empty")
        updates.title = t
      }
      if (typeof body === "string") {
        if (!isAuthor && !access.write) throw new Error("Only the author or repo writers can edit")
        updates.body = body.trim() || null
      }
      if (typeof state === "string") {
        if (!access.write) throw new Error("Repo writer access required")
        if (state !== "open" && state !== "closed") throw new Error("state must be open or closed")
        updates.state = state
        if (state === "closed" && issue.state === "open") {
          updates.closed_at = raw("NOW()")
          updates.closed_by = userId
        }
        if (state === "open" && issue.state === "closed") {
          updates.closed_at = null
          updates.closed_by = null
        }
      }
      if (Object.keys(updates).length === 0) throw new Error("No fields to update")
      updates.updated_at = raw("NOW()")
      await ctx.db.execute(from("issues").where(q => q("id").equals(issue.id)).update(updates))

      const fresh = await ctx.db.one(
        from("issues").where(q => q("id").equals(issue.id))
          .select("id", "number", "title", "body", "state", "user_id", "comment_count", "created_at", "updated_at", "closed_at"),
      ) as { id: number; number: number; title: string; state: string } & Record<string, unknown> | null
      const action = state === "closed" && issue.state === "open" ? "closed"
        : state === "open" && issue.state === "closed" ? "reopened"
        : "edited"
      if (fresh) {
        dispatchWebhook(ctx.db, repo.id, "issues", {
          event: "issues", action,
          repository: { id: repo.id, owner: repo.owner_login, name: repo.name },
          issue: fresh, sender: { id: userId },
        })
      }
      return fresh
    },
  }),

  defineTool({
    name: "tangle.issues.comment",
    description: "Append a comment on an existing issue.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        name: { type: "string" },
        number: { type: "number" },
        body: { type: "string" },
      },
      required: ["owner", "name", "number", "body"],
    },
    handler: async ({ owner, name, number, body }: any) => {
      const userId = requireUser(ctx)
      const repo = await findRepo(ctx.db, String(owner), String(name))
      if (!repo) throw new Error(`Repo ${owner}/${name} not found`)
      const access = await resolveRepoAccess(ctx.db, repo, userId)
      if (!access.read) throw new Error(`Repo ${owner}/${name} not found`)
      const issue = await ctx.db.one(
        from("issues").where(q => q("repo_id").equals(repo.id)).where(q => q("number").equals(Number(number))).select("id"),
      ) as { id: number } | null
      if (!issue) throw new Error("Issue not found")
      const text = String(body ?? "").trim()
      if (!text) throw new Error("body required")
      const inserted = await ctx.db.execute(
        from("comments").insert({
          subject_kind: "issue", subject_id: issue.id, user_id: userId, body: text,
        }).returning("id", "body", "edited_at", "created_at"),
      ) as Array<{ id: number; body: string; edited_at: string | null; created_at: string }>
      void ctx.db.execute(
        from("issues").where(q => q("id").equals(issue.id)).update({
          comment_count: raw("comment_count + 1"),
          updated_at: raw("NOW()"),
        }),
      ).catch(() => {})
      return inserted[0]
    },
  }),

  defineTool({
    name: "tangle.issues.list_comments",
    description: "List comments on an issue, oldest-first, with rendered markdown.",
    inputSchema: {
      type: "object",
      properties: { owner: { type: "string" }, name: { type: "string" }, number: { type: "number" } },
      required: ["owner", "name", "number"],
    },
    handler: async ({ owner, name, number }: any) => {
      const repo = await findRepo(ctx.db, String(owner), String(name))
      if (!repo) throw new Error(`Repo ${owner}/${name} not found`)
      const access = await resolveRepoAccess(ctx.db, repo, ctx.userId)
      if (!access.read) throw new Error(`Repo ${owner}/${name} not found`)
      const issue = await ctx.db.one(
        from("issues").where(q => q("repo_id").equals(repo.id)).where(q => q("number").equals(Number(number))).select("id"),
      ) as { id: number } | null
      if (!issue) throw new Error("Issue not found")
      const rows = await ctx.db.all(
        from("comments")
          .where(q => q("subject_kind").equals("issue"))
          .where(q => q("subject_id").equals(issue.id))
          .select("id", "user_id", "body", "edited_at", "created_at")
          .orderBy("created_at", "ASC"),
      ) as Array<{ id: number; user_id: number | null; body: string; edited_at: string | null; created_at: string }>
      return rows.map(r => ({ ...r, body_html: renderMarkdown(r.body) }))
    },
  }),
]
