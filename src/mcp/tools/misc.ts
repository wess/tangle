import { from } from "@atlas/db"
import { defineTool } from "@atlas/mcp"
import type { TangleMcpContext } from "../context.ts"
import { findRepo, resolveRepoAccess } from "../../permissions/index.ts"

const requireUser = (ctx: TangleMcpContext): number => {
  if (ctx.userId === null) throw new Error("This tool requires authentication. Set TANGLE_MCP_USER.")
  return ctx.userId
}

// Smaller domain tools — labels, releases, webhooks, users — bundled
// here because each is short and they all share the same shape.

export const miscTools = (ctx: TangleMcpContext) => [
  defineTool({
    name: "tangle.users.me",
    description: "Identity the MCP server is currently acting as. Useful first call for any session.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      if (!ctx.user) return { anonymous: true }
      return { ...ctx.user, anonymous: false }
    },
  }),

  defineTool({
    name: "tangle.users.search",
    description: "Substring search across discoverable users by username or display name.",
    inputSchema: {
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    },
    handler: async ({ q }: any) => {
      const term = String(q ?? "").trim()
      if (!term) return []
      const pattern = `%${term.replace(/[%_]/g, m => `\\${m}`)}%`
      const rows = await ctx.db.all(
        from("users")
          .where(qb => qb.or(qb("username").ilike(pattern), qb("name").ilike(pattern)))
          .where(qb => qb("deleted_at").isNull())
          .where(qb => qb("discoverable").equals(true))
          .select("id", "username", "name", "avatar_key")
          .orderBy("username", "ASC")
          .limit(20),
      )
      return rows
    },
  }),

  defineTool({
    name: "tangle.labels.list",
    description: "List all labels defined on a repository.",
    inputSchema: {
      type: "object",
      properties: { owner: { type: "string" }, name: { type: "string" } },
      required: ["owner", "name"],
    },
    handler: async ({ owner, name }: any) => {
      const repo = await findRepo(ctx.db, String(owner), String(name))
      if (!repo) throw new Error(`Repo ${owner}/${name} not found`)
      const access = await resolveRepoAccess(ctx.db, repo, ctx.userId)
      if (!access.read) throw new Error(`Repo ${owner}/${name} not found`)
      return await ctx.db.all(
        from("labels").where(q => q("repo_id").equals(repo.id))
          .select("id", "name", "color", "description", "created_at")
          .orderBy("name", "ASC"),
      )
    },
  }),

  defineTool({
    name: "tangle.labels.create",
    description: "Create a label on a repository. Color is a 3- or 6-digit hex without the '#'.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        name: { type: "string" },
        label: { type: "string", description: "The label's name." },
        color: { type: "string" },
        description: { type: "string" },
      },
      required: ["owner", "name", "label"],
    },
    handler: async ({ owner, name, label, color, description }: any) => {
      const userId = requireUser(ctx)
      const repo = await findRepo(ctx.db, String(owner), String(name))
      if (!repo) throw new Error(`Repo ${owner}/${name} not found`)
      const access = await resolveRepoAccess(ctx.db, repo, userId)
      if (!access.write) throw new Error("Repo writer access required")
      const lbl = String(label ?? "").trim()
      if (!lbl) throw new Error("label name required")
      const hex = String(color ?? "5E81AC").replace(/^#/, "")
      if (!/^[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(hex)) throw new Error("color must be a 3- or 6-digit hex")
      const inserted = await ctx.db.execute(
        from("labels").insert({
          repo_id: repo.id,
          name: lbl,
          color: hex.toUpperCase(),
          description: typeof description === "string" ? description.trim() || null : null,
        }).returning("id", "name", "color", "description", "created_at"),
      ) as Array<unknown>
      return inserted[0]
    },
  }),

  defineTool({
    name: "tangle.releases.list",
    description: "List releases for a repository, newest-first.",
    inputSchema: {
      type: "object",
      properties: { owner: { type: "string" }, name: { type: "string" } },
      required: ["owner", "name"],
    },
    handler: async ({ owner, name }: any) => {
      const repo = await findRepo(ctx.db, String(owner), String(name))
      if (!repo) throw new Error(`Repo ${owner}/${name} not found`)
      const access = await resolveRepoAccess(ctx.db, repo, ctx.userId)
      if (!access.read) throw new Error(`Repo ${owner}/${name} not found`)
      return await ctx.db.all(
        from("releases").where(q => q("repo_id").equals(repo.id))
          .select("id", "tag_name", "name", "body", "is_draft", "is_prerelease", "user_id", "published_at", "created_at")
          .orderBy("created_at", "DESC")
          .limit(100),
      )
    },
  }),

  defineTool({
    name: "tangle.webhooks.list",
    description: "List webhooks configured on a repository (admin access required).",
    inputSchema: {
      type: "object",
      properties: { owner: { type: "string" }, name: { type: "string" } },
      required: ["owner", "name"],
    },
    handler: async ({ owner, name }: any) => {
      const userId = requireUser(ctx)
      const repo = await findRepo(ctx.db, String(owner), String(name))
      if (!repo) throw new Error(`Repo ${owner}/${name} not found`)
      const access = await resolveRepoAccess(ctx.db, repo, userId)
      if (!access.admin) throw new Error("Repo admin access required")
      return await ctx.db.all(
        from("webhooks").where(q => q("repo_id").equals(repo.id))
          .select("id", "url", "content_type", "events", "active", "created_at")
          .orderBy("created_at", "DESC"),
      )
    },
  }),

  defineTool({
    name: "tangle.webhooks.deliveries",
    description: "Recent webhook delivery attempts with status codes and timing. Useful for debugging integrations.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        name: { type: "string" },
        webhook_id: { type: "number" },
      },
      required: ["owner", "name", "webhook_id"],
    },
    handler: async ({ owner, name, webhook_id }: any) => {
      const userId = requireUser(ctx)
      const repo = await findRepo(ctx.db, String(owner), String(name))
      if (!repo) throw new Error(`Repo ${owner}/${name} not found`)
      const access = await resolveRepoAccess(ctx.db, repo, userId)
      if (!access.admin) throw new Error("Repo admin access required")
      const wh = await ctx.db.one(
        from("webhooks").where(q => q("id").equals(Number(webhook_id))).where(q => q("repo_id").equals(repo.id)).select("id"),
      ) as { id: number } | null
      if (!wh) throw new Error("Webhook not found")
      return await ctx.db.all(
        from("webhook_deliveries").where(q => q("webhook_id").equals(wh.id))
          .select("id", "event", "status_code", "duration_ms", "response_body", "delivered_at")
          .orderBy("delivered_at", "DESC")
          .limit(50),
      )
    },
  }),

  defineTool({
    name: "tangle.git.clone_url",
    description: "Build the HTTPS clone URL for a repository, with usage hints. The MCP can hand this to the user along with PAT instructions.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        name: { type: "string" },
        base_url: { type: "string", description: "Override (e.g. https://tangle.io). Defaults to APP_URL minus the SPA port." },
      },
      required: ["owner", "name"],
    },
    handler: async ({ owner, name, base_url }: any) => {
      const repo = await findRepo(ctx.db, String(owner), String(name))
      if (!repo) throw new Error(`Repo ${owner}/${name} not found`)
      const access = await resolveRepoAccess(ctx.db, repo, ctx.userId)
      if (!access.read) throw new Error(`Repo ${owner}/${name} not found`)
      const base = (typeof base_url === "string" && base_url.trim())
        || process.env.APP_URL?.replace(":3001", ":3000")
        || "http://localhost:3000"
      return {
        clone_url: `${base.replace(/\/$/, "")}/${repo.owner_login}/${repo.name}.git`,
        is_private: repo.is_private,
        hint: repo.is_private
          ? "Private repo. Use a personal access token as the password — generate one at /settings/tokens."
          : "Public repo. Read access is unauthenticated; pushes still need a PAT.",
      }
    },
  }),
]
