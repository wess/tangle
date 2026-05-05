import { from, raw } from "@atlas/db"
import { defineTool } from "@atlas/mcp"
import type { TangleMcpContext } from "../context.ts"
import { findRepo, resolveRepoAccess } from "../../permissions/index.ts"
import { cloneBareRepo, dropBareRepo, fetchMirror, initBareRepo } from "../../git/repo.ts"

// Domain tools wrap the same modules the HTTP API uses, but bypass
// `requireAuth` / `parseJson` / etc. since the MCP server runs in-
// process. The auth model is the resolved `ctx.userId`; tools enforce
// it via resolveRepoAccess just like the HTTP routes do.

const requireUser = (ctx: TangleMcpContext): number => {
  if (ctx.userId === null) throw new Error("This tool requires authentication. Set TANGLE_MCP_USER to a user (or omit it for owner).")
  return ctx.userId
}

const REPO_NAME_RE = /^[a-zA-Z0-9._-]{1,100}$/
const isValidRepoName = (s: string) => REPO_NAME_RE.test(s) && s !== "." && s !== ".."

export const repoTools = (ctx: TangleMcpContext) => [
  defineTool({
    name: "tangle.repos.list_mine",
    description: "List repositories the current user owns, collaborates on, or has access to via an org. Returns up to 200 most-recent.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const userId = requireUser(ctx)
      const text = `
        SELECT r.id, r.owner_login, r.name, r.description, r.is_private,
               r.default_branch, r.is_archived, r.star_count, r.size_bytes,
               r.pushed_at, r.created_at, r.fork_of, r.mirror_url
        FROM repos r
        WHERE r.deleted_at IS NULL AND (
          (r.owner_kind = 'user' AND r.owner_id = $1)
          OR (r.owner_kind = 'org' AND r.owner_id IN (
            SELECT org_id FROM org_members WHERE user_id = $1
          ))
          OR EXISTS (SELECT 1 FROM repo_collaborators c WHERE c.repo_id = r.id AND c.user_id = $1)
        )
        ORDER BY COALESCE(r.pushed_at, r.created_at) DESC
        LIMIT 200
      `
      return await ctx.db.execute({ text, values: [userId] })
    },
  }),

  defineTool({
    name: "tangle.repos.list_by_owner",
    description: "List the repositories under a given owner (user or org). Private repos are filtered to those the current user can see.",
    inputSchema: {
      type: "object",
      properties: { owner: { type: "string", description: "Owner login (user or org)." } },
      required: ["owner"],
    },
    handler: async ({ owner }: any) => {
      const userId = ctx.userId ?? 0
      const text = `
        SELECT r.id, r.owner_login, r.name, r.description, r.is_private,
               r.default_branch, r.is_archived, r.star_count, r.pushed_at, r.created_at
        FROM repos r
        WHERE r.deleted_at IS NULL AND r.owner_login = $1
          AND (
            r.is_private = false
            OR (r.owner_kind = 'user' AND r.owner_id = $2)
            OR (r.owner_kind = 'org' AND r.owner_id IN (
              SELECT org_id FROM org_members WHERE user_id = $2
            ))
            OR EXISTS (SELECT 1 FROM repo_collaborators c WHERE c.repo_id = r.id AND c.user_id = $2)
          )
        ORDER BY r.name ASC
      `
      return await ctx.db.execute({ text, values: [String(owner).toLowerCase(), userId] })
    },
  }),

  defineTool({
    name: "tangle.repos.get",
    description: "Fetch a single repository's metadata, including the calling user's effective role.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        name: { type: "string" },
      },
      required: ["owner", "name"],
    },
    handler: async ({ owner, name }: any) => {
      const repo = await findRepo(ctx.db, String(owner), String(name))
      if (!repo) throw new Error(`Repo ${owner}/${name} not found`)
      const access = await resolveRepoAccess(ctx.db, repo, ctx.userId)
      if (!access.read) throw new Error(`Repo ${owner}/${name} not found`)
      return { ...repo, viewer_role: access.role }
    },
  }),

  defineTool({
    name: "tangle.repos.create",
    description: "Create a new repository owned by the current user (or an org login they belong to). Initializes the bare git repo on disk.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        owner: { type: "string", description: "Optional. Defaults to the current user's username." },
        description: { type: "string" },
        is_private: { type: "boolean", description: "Default true." },
        default_branch: { type: "string", description: "Default 'main'." },
      },
      required: ["name"],
    },
    handler: async ({ name, owner, description, is_private, default_branch }: any) => {
      const userId = requireUser(ctx)
      if (typeof name !== "string" || !isValidRepoName(name)) {
        throw new Error("name must be 1-100 chars: letters, digits, dot, dash, underscore (no leading dots)")
      }

      // Same logic as src/repos/index.ts POST /repos — kept out-of-line
      // because the MCP arrives without the JSON parser middleware.
      const ownerInput = typeof owner === "string" ? owner : ctx.user?.username
      if (!ownerInput) throw new Error("Cannot determine owner. Pass `owner` explicitly.")

      const self = ctx.user
      let ownerKind: "user" | "org"
      let ownerId: number
      let ownerLogin: string
      if (self && self.username === ownerInput.toLowerCase()) {
        ownerKind = "user"; ownerId = self.id; ownerLogin = self.username
      } else {
        const org = await ctx.db.one(
          from("orgs").where(q => q("login").equals(ownerInput.toLowerCase())).select("id", "login"),
        ) as { id: number; login: string } | null
        if (!org) throw new Error(`Owner '${ownerInput}' not found`)
        const member = await ctx.db.one(
          from("org_members")
            .where(q => q("org_id").equals(org.id))
            .where(q => q("user_id").equals(userId))
            .select("role"),
        )
        if (!member) throw new Error(`Not a member of '${ownerInput}'`)
        ownerKind = "org"; ownerId = org.id; ownerLogin = org.login
      }

      const dup = await ctx.db.one(
        from("repos")
          .where(q => q("owner_login").equals(ownerLogin))
          .where(q => q("name").equals(name))
          .where(q => q("deleted_at").isNull())
          .select("id"),
      )
      if (dup) throw new Error("A repo with that name already exists")

      const branch = (typeof default_branch === "string" && default_branch.trim()) || "main"
      const inserted = await ctx.db.execute(
        from("repos").insert({
          owner_kind: ownerKind,
          owner_id: ownerId,
          owner_login: ownerLogin,
          name,
          description: typeof description === "string" ? description : null,
          is_private: is_private !== false,
          default_branch: branch,
        }).returning("id", "owner_login", "name", "description", "is_private", "default_branch", "created_at"),
      ) as Array<{ id: number; owner_login: string; name: string; description: string | null; is_private: boolean; default_branch: string; created_at: string }>
      const repo = inserted[0]!

      try {
        await initBareRepo(ctx.repoDir, ownerLogin, name, branch)
      } catch (err) {
        await ctx.db.execute(from("repos").where(q => q("id").equals(repo.id)).del())
        throw new Error(`Failed to initialize git repo: ${err}`)
      }
      return repo
    },
  }),

  defineTool({
    name: "tangle.repos.delete",
    description: "Soft-delete a repository (admin access required). Drops the bare repo from disk.",
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
      if (!access.admin) throw new Error("Admin access required")

      await ctx.db.execute(
        from("repos").where(q => q("id").equals(repo.id)).update({ deleted_at: raw("NOW()") }),
      )
      await dropBareRepo(ctx.repoDir, repo.owner_login, repo.name).catch(() => {})
      return { deleted: repo.id }
    },
  }),

  defineTool({
    name: "tangle.repos.fork",
    description: "Fork a repository into the current user's namespace (or another org they belong to). Copies the bare repo on disk.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        name: { type: "string" },
        target_owner: { type: "string", description: "Optional. Defaults to the current user." },
        target_name: { type: "string", description: "Optional. Defaults to the source repo name." },
      },
      required: ["owner", "name"],
    },
    handler: async ({ owner, name, target_owner, target_name }: any) => {
      const userId = requireUser(ctx)
      const source = await findRepo(ctx.db, String(owner), String(name))
      if (!source) throw new Error(`Repo ${owner}/${name} not found`)
      const access = await resolveRepoAccess(ctx.db, source, userId)
      if (!access.read) throw new Error(`Repo ${owner}/${name} not found`)

      const tName = (typeof target_name === "string" && target_name) || source.name
      if (!isValidRepoName(tName)) throw new Error("target_name has invalid characters")

      const tOwnerLogin = (typeof target_owner === "string" && target_owner.toLowerCase()) || ctx.user?.username
      if (!tOwnerLogin) throw new Error("Cannot determine target owner")

      let tKind: "user" | "org" = "user"
      let tId = ctx.user?.id ?? 0
      if (tOwnerLogin !== ctx.user?.username) {
        const org = await ctx.db.one(
          from("orgs").where(q => q("login").equals(tOwnerLogin)).select("id"),
        ) as { id: number } | null
        if (!org) throw new Error(`Target owner '${tOwnerLogin}' not found`)
        const member = await ctx.db.one(
          from("org_members")
            .where(q => q("org_id").equals(org.id))
            .where(q => q("user_id").equals(userId))
            .select("role"),
        )
        if (!member) throw new Error(`Not a member of '${tOwnerLogin}'`)
        tKind = "org"; tId = org.id
      }

      const conflict = await ctx.db.one(
        from("repos")
          .where(q => q("owner_login").equals(tOwnerLogin))
          .where(q => q("name").equals(tName))
          .where(q => q("deleted_at").isNull())
          .select("id"),
      )
      if (conflict) throw new Error("A repo with that name already exists in the target owner")

      const inserted = await ctx.db.execute(
        from("repos").insert({
          owner_kind: tKind,
          owner_id: tId,
          owner_login: tOwnerLogin,
          name: tName,
          description: source.description,
          is_private: source.is_private,
          default_branch: source.default_branch,
          fork_of: source.id,
        }).returning("id", "owner_login", "name", "default_branch", "created_at"),
      ) as Array<{ id: number; owner_login: string; name: string; default_branch: string; created_at: string }>
      const fork = inserted[0]!

      try {
        await cloneBareRepo(ctx.repoDir, source.owner_login, source.name, tOwnerLogin, tName)
      } catch (err) {
        await ctx.db.execute(from("repos").where(q => q("id").equals(fork.id)).del())
        throw new Error(`Failed to clone bare repo: ${err}`)
      }
      return { ...fork, fork_of: source.id }
    },
  }),

  defineTool({
    name: "tangle.repos.set_mirror",
    description: "Configure (or clear) an upstream mirror URL on a repository. Triggers an immediate fetch when set.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        name: { type: "string" },
        url: { type: "string", description: "External git URL. Use empty string or omit to disable." },
      },
      required: ["owner", "name"],
    },
    handler: async ({ owner, name, url }: any) => {
      const userId = requireUser(ctx)
      const repo = await findRepo(ctx.db, String(owner), String(name))
      if (!repo) throw new Error(`Repo ${owner}/${name} not found`)
      const access = await resolveRepoAccess(ctx.db, repo, userId)
      if (!access.admin) throw new Error("Admin access required")

      const u = typeof url === "string" ? url.trim() : ""
      if (!u) {
        await ctx.db.execute(
          from("repos").where(q => q("id").equals(repo.id)).update({
            mirror_url: null, mirror_last_synced_at: null, mirror_last_error: null,
          }),
        )
        return { mirror_url: null }
      }
      if (!/^https?:\/\//i.test(u) && !/^git@/.test(u)) {
        throw new Error("Mirror URL must be http(s) or git@ form")
      }
      await ctx.db.execute(
        from("repos").where(q => q("id").equals(repo.id)).update({ mirror_url: u, mirror_last_error: null }),
      )
      // Synchronous fetch — MCP callers expect the operation to
      // complete before returning, unlike the HTTP route which kicks
      // it off in the background.
      try {
        await fetchMirror(ctx.repoDir, repo.owner_login, repo.name, u)
        await ctx.db.execute(
          from("repos").where(q => q("id").equals(repo.id)).update({
            mirror_last_synced_at: raw("NOW()"),
            mirror_last_error: null,
            pushed_at: raw("NOW()"),
          }),
        )
        return { mirror_url: u, synced: true }
      } catch (err) {
        const message = String(err).slice(0, 1000)
        await ctx.db.execute(
          from("repos").where(q => q("id").equals(repo.id)).update({ mirror_last_error: message }),
        ).catch(() => {})
        throw new Error(`Mirror set, but initial fetch failed: ${message}`)
      }
    },
  }),
]
