import { from, raw } from "@atlas/db"
import { defineTool } from "@atlas/mcp"
import type { TangleMcpContext } from "../context.ts"
import { findRepo, resolveRepoAccess } from "../../permissions/index.ts"
import { renderMarkdown } from "../../markdown/index.ts"
import { dispatchWebhook } from "../../webhooks/dispatch.ts"
import { nextIssueNumber } from "../../issues/index.ts"
import { resolveRepoPath } from "../../git/repo.ts"
import { diffBetween, fastForwardMerge, resolveBranchSha } from "../../git/merge.ts"

const requireUser = (ctx: TangleMcpContext): number => {
  if (ctx.userId === null) throw new Error("This tool requires authentication. Set TANGLE_MCP_USER.")
  return ctx.userId
}

export const pullTools = (ctx: TangleMcpContext) => [
  defineTool({
    name: "tangle.pulls.list",
    description: "List pull requests for a repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        name: { type: "string" },
        state: { type: "string", enum: ["open", "closed", "merged", "all"] },
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
      let q = from("pulls")
        .where(qb => qb("repo_id").equals(repo.id))
        .select("id", "number", "title", "state", "user_id", "head_branch", "base_branch", "comment_count", "merged_at", "created_at", "updated_at")
        .orderBy("id", "DESC")
        .limit(lim)
      if (s !== "all") q = q.where(qb => qb("state").equals(s))
      return await ctx.db.all(q)
    },
  }),

  defineTool({
    name: "tangle.pulls.get",
    description: "Fetch a pull request by number, including the rendered description.",
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
      const pull = await ctx.db.one(
        from("pulls")
          .where(q => q("repo_id").equals(repo.id))
          .where(q => q("number").equals(Number(number)))
          .select(
            "id", "number", "title", "body", "state", "user_id",
            "head_repo_id", "head_branch", "base_branch",
            "merge_commit_sha", "merged_at", "merged_by",
            "closed_at", "closed_by", "comment_count",
            "created_at", "updated_at",
          ),
      ) as { body: string | null } & Record<string, unknown> | null
      if (!pull) throw new Error("Pull request not found")
      return { ...pull, body_html: renderMarkdown(pull.body) }
    },
  }),

  defineTool({
    name: "tangle.pulls.create",
    description: "Open a new pull request comparing a head branch against a base branch.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        name: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        head: { type: "string", description: "Branch with the changes." },
        base: { type: "string", description: "Branch to merge into. Defaults to the repo's default branch." },
      },
      required: ["owner", "name", "title", "head"],
    },
    handler: async ({ owner, name, title, body, head, base }: any) => {
      const userId = requireUser(ctx)
      const repo = await findRepo(ctx.db, String(owner), String(name))
      if (!repo) throw new Error(`Repo ${owner}/${name} not found`)
      const access = await resolveRepoAccess(ctx.db, repo, userId)
      if (!access.read) throw new Error(`Repo ${owner}/${name} not found`)
      const t = String(title ?? "").trim()
      if (!t) throw new Error("title required")
      const h = String(head ?? "").trim()
      if (!h) throw new Error("head required")
      const b = (typeof base === "string" && base.trim()) || repo.default_branch
      if (h === b) throw new Error("head and base cannot be the same branch")

      const number = await nextIssueNumber(ctx.db, repo.id)
      const inserted = await ctx.db.execute(
        from("pulls").insert({
          repo_id: repo.id, number, user_id: userId, title: t,
          body: typeof body === "string" ? body.trim() || null : null,
          head_repo_id: repo.id, head_branch: h, base_branch: b,
        }).returning("id", "number", "title", "state", "head_branch", "base_branch", "created_at"),
      ) as Array<{ id: number; number: number; title: string; state: string; head_branch: string; base_branch: string; created_at: string }>
      const pull = inserted[0]!
      dispatchWebhook(ctx.db, repo.id, "pull_request", {
        event: "pull_request", action: "opened",
        repository: { id: repo.id, owner: repo.owner_login, name: repo.name },
        pull_request: pull, sender: { id: userId },
      })
      return pull
    },
  }),

  defineTool({
    name: "tangle.pulls.diff",
    description: "Return the unified diff between a PR's base and head branches plus a file/+/-/lines summary.",
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
      const pull = await ctx.db.one(
        from("pulls").where(q => q("repo_id").equals(repo.id)).where(q => q("number").equals(Number(number)))
          .select("id", "head_repo_id", "head_branch", "base_branch"),
      ) as { id: number; head_repo_id: number | null; head_branch: string; base_branch: string } | null
      if (!pull) throw new Error("Pull request not found")
      if (pull.head_repo_id && pull.head_repo_id !== repo.id) {
        return { cross_repo: true, head_repo_id: pull.head_repo_id, base: pull.base_branch, head: pull.head_branch }
      }
      const gitdir = resolveRepoPath(ctx.repoDir, repo.owner_login, repo.name)
      const [baseSha, headSha] = await Promise.all([
        resolveBranchSha(gitdir, pull.base_branch),
        resolveBranchSha(gitdir, pull.head_branch),
      ])
      if (!baseSha || !headSha) throw new Error("Base or head branch is missing")
      const diff = await diffBetween(gitdir, baseSha, headSha)
      if (!diff) throw new Error("Failed to compute diff")
      return { ...diff, base_branch: pull.base_branch, head_branch: pull.head_branch }
    },
  }),

  defineTool({
    name: "tangle.pulls.merge",
    description: "Fast-forward merge a pull request. Refuses if FF isn't possible — caller must rebase locally and push.",
    inputSchema: {
      type: "object",
      properties: { owner: { type: "string" }, name: { type: "string" }, number: { type: "number" } },
      required: ["owner", "name", "number"],
    },
    handler: async ({ owner, name, number }: any) => {
      const userId = requireUser(ctx)
      const repo = await findRepo(ctx.db, String(owner), String(name))
      if (!repo) throw new Error(`Repo ${owner}/${name} not found`)
      const access = await resolveRepoAccess(ctx.db, repo, userId)
      if (!access.write) throw new Error("Repo writer access required")
      const pull = await ctx.db.one(
        from("pulls").where(q => q("repo_id").equals(repo.id)).where(q => q("number").equals(Number(number)))
          .select("id", "state", "head_repo_id", "head_branch", "base_branch", "merged_at"),
      ) as {
        id: number; state: string; head_repo_id: number | null
        head_branch: string; base_branch: string; merged_at: string | null
      } | null
      if (!pull) throw new Error("Pull request not found")
      if (pull.merged_at) throw new Error("Already merged")
      if (pull.state !== "open") throw new Error("Pull request is not open")
      if (pull.head_repo_id && pull.head_repo_id !== repo.id) throw new Error("Cross-repo merges are not yet supported")

      const gitdir = resolveRepoPath(ctx.repoDir, repo.owner_login, repo.name)
      const headSha = await resolveBranchSha(gitdir, pull.head_branch)
      if (!headSha) throw new Error("Head branch is missing")
      const result = await fastForwardMerge(gitdir, pull.base_branch, headSha)
      if (!result.ok) {
        if (result.reason === "not-ancestor") throw new Error("Cannot fast-forward — base has diverged. Rebase head onto base, then push.")
        if (result.reason === "missing-ref") throw new Error("Base branch is missing")
        throw new Error(`Ref update failed: ${result.detail}`)
      }
      await ctx.db.execute(
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
      void ctx.db.execute(
        from("repos").where(q => q("id").equals(repo.id)).update({ pushed_at: raw("NOW()") }),
      ).catch(() => {})
      dispatchWebhook(ctx.db, repo.id, "pull_request", {
        event: "pull_request", action: "merged",
        repository: { id: repo.id, owner: repo.owner_login, name: repo.name },
        pull_request: { ...pull, merge_commit_sha: result.sha, state: "closed" },
        sender: { id: userId },
      })
      return { merged: true, mode: result.mode, sha: result.sha, base_branch: pull.base_branch }
    },
  }),

  defineTool({
    name: "tangle.pulls.comment",
    description: "Post a comment on a pull request.",
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
      const pull = await ctx.db.one(
        from("pulls").where(q => q("repo_id").equals(repo.id)).where(q => q("number").equals(Number(number))).select("id"),
      ) as { id: number } | null
      if (!pull) throw new Error("Pull request not found")
      const text = String(body ?? "").trim()
      if (!text) throw new Error("body required")
      const inserted = await ctx.db.execute(
        from("comments").insert({
          subject_kind: "pull", subject_id: pull.id, user_id: userId, body: text,
        }).returning("id", "body", "edited_at", "created_at"),
      ) as Array<{ id: number; body: string; edited_at: string | null; created_at: string }>
      void ctx.db.execute(
        from("pulls").where(q => q("id").equals(pull.id)).update({
          comment_count: raw("comment_count + 1"),
          updated_at: raw("NOW()"),
        }),
      ).catch(() => {})
      return inserted[0]
    },
  }),
]
