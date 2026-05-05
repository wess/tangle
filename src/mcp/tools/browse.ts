import { defineTool } from "@atlas/mcp"
import type { TangleMcpContext } from "../context.ts"
import { findRepo, resolveRepoAccess } from "../../permissions/index.ts"
import { resolveRepoPath } from "../../git/repo.ts"
import { listCommits, listRefs, readBlobPath, readTreePath, resolveBrowseRef } from "../../git/read.ts"
import { renderMarkdown } from "../../markdown/index.ts"

const README_CANDIDATES = ["README.md", "Readme.md", "readme.md", "README", "README.markdown", "README.txt"]

const checkAccess = async (ctx: TangleMcpContext, owner: string, name: string) => {
  const repo = await findRepo(ctx.db, owner, name)
  if (!repo) throw new Error(`Repo ${owner}/${name} not found`)
  const access = await resolveRepoAccess(ctx.db, repo, ctx.userId)
  if (!access.read) throw new Error(`Repo ${owner}/${name} not found`)
  return repo
}

export const browseTools = (ctx: TangleMcpContext) => [
  defineTool({
    name: "tangle.git.refs",
    description: "List a repository's branches and tags with their tip commit SHAs.",
    inputSchema: {
      type: "object",
      properties: { owner: { type: "string" }, name: { type: "string" } },
      required: ["owner", "name"],
    },
    handler: async ({ owner, name }: any) => {
      const repo = await checkAccess(ctx, String(owner), String(name))
      return await listRefs(resolveRepoPath(ctx.repoDir, repo.owner_login, repo.name), repo.default_branch)
    },
  }),

  defineTool({
    name: "tangle.git.tree",
    description: "List the contents of a directory at a given ref. Pass empty path for the repo root.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        name: { type: "string" },
        ref: { type: "string", description: "Branch / tag / SHA. Defaults to the repo's default branch." },
        path: { type: "string", description: "Path under the repo root. Empty for root." },
      },
      required: ["owner", "name"],
    },
    handler: async ({ owner, name, ref, path }: any) => {
      const repo = await checkAccess(ctx, String(owner), String(name))
      const gitdir = resolveRepoPath(ctx.repoDir, repo.owner_login, repo.name)
      const refInput = (typeof ref === "string" && ref) || repo.default_branch
      const resolved = await resolveBrowseRef(gitdir, refInput, repo.default_branch)
      if (!resolved) return { empty: true, ref: refInput, entries: [] }
      const entries = await readTreePath(gitdir, resolved.oid, typeof path === "string" ? path : "")
      if (entries === null) throw new Error("Path not found at this ref")
      return { ref: resolved.ref, commit: resolved.oid, entries }
    },
  }),

  defineTool({
    name: "tangle.git.blob",
    description: "Read the contents of a file at a given ref. Returns text for utf-8 files; binary blobs return only metadata.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        name: { type: "string" },
        ref: { type: "string" },
        path: { type: "string" },
      },
      required: ["owner", "name", "path"],
    },
    handler: async ({ owner, name, ref, path }: any) => {
      const repo = await checkAccess(ctx, String(owner), String(name))
      const gitdir = resolveRepoPath(ctx.repoDir, repo.owner_login, repo.name)
      const refInput = (typeof ref === "string" && ref) || repo.default_branch
      const resolved = await resolveBrowseRef(gitdir, refInput, repo.default_branch)
      if (!resolved) throw new Error("Ref not found")
      if (typeof path !== "string" || !path) throw new Error("path required")
      const blob = await readBlobPath(gitdir, resolved.oid, path)
      if (!blob) throw new Error(`Blob not found: ${path}`)
      return {
        ref: resolved.ref,
        commit: resolved.oid,
        path,
        oid: blob.oid,
        size: blob.size,
        is_binary: blob.isBinary,
        text: blob.text ?? null,
      }
    },
  }),

  defineTool({
    name: "tangle.git.commits",
    description: "Page through commits reachable from a ref. Returns the most-recent first.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        name: { type: "string" },
        ref: { type: "string" },
        page: { type: "number", description: "1-indexed page. Default 1." },
      },
      required: ["owner", "name"],
    },
    handler: async ({ owner, name, ref, page }: any) => {
      const repo = await checkAccess(ctx, String(owner), String(name))
      const gitdir = resolveRepoPath(ctx.repoDir, repo.owner_login, repo.name)
      const refInput = (typeof ref === "string" && ref) || repo.default_branch
      const resolved = await resolveBrowseRef(gitdir, refInput, repo.default_branch)
      if (!resolved) return { ref: refInput, commits: [] }
      const p = Math.max(1, Number(page ?? 1) || 1)
      const commits = await listCommits(gitdir, resolved.oid, { skip: (p - 1) * 50, depth: 50 })
      return { ref: resolved.ref, commit: resolved.oid, page: p, commits }
    },
  }),

  defineTool({
    name: "tangle.git.readme",
    description: "Fetch the rendered README for a repository (markdown picked up from the default branch).",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        name: { type: "string" },
        ref: { type: "string" },
      },
      required: ["owner", "name"],
    },
    handler: async ({ owner, name, ref }: any) => {
      const repo = await checkAccess(ctx, String(owner), String(name))
      const gitdir = resolveRepoPath(ctx.repoDir, repo.owner_login, repo.name)
      const refInput = (typeof ref === "string" && ref) || repo.default_branch
      const resolved = await resolveBrowseRef(gitdir, refInput, repo.default_branch)
      if (!resolved) return { ref: refInput, path: null, text: null, html: null }
      const root = await readTreePath(gitdir, resolved.oid, "")
      if (!root) return { ref: resolved.ref, path: null, text: null, html: null }
      const lower = new Map(root.filter(e => e.type === "blob").map(e => [e.path.toLowerCase(), e.path]))
      let match: string | null = null
      for (const candidate of README_CANDIDATES) {
        const found = lower.get(candidate.toLowerCase())
        if (found) { match = found; break }
      }
      if (!match) return { ref: resolved.ref, path: null, text: null, html: null }
      const blob = await readBlobPath(gitdir, resolved.oid, match)
      if (!blob || blob.isBinary) return { ref: resolved.ref, path: match, text: null, html: null }
      const isMarkdown = /\.md$|\.markdown$/i.test(match)
      return {
        ref: resolved.ref,
        path: match,
        text: blob.text ?? null,
        html: isMarkdown ? renderMarkdown(blob.text ?? "") : null,
      }
    },
  }),
]
