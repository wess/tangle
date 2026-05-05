import type { Connection } from "@atlas/db"
import { get, json, pipeline } from "@atlas/server"
import { optionalAuth } from "../auth/guard.ts"
import { findRepo, resolveRepoAccess } from "../permissions/index.ts"
import { resolveRepoPath } from "../git/repo.ts"
import { listCommits, listRefs, readBlobPath, readTreePath, resolveBrowseRef } from "../git/read.ts"
import { renderMarkdown } from "../markdown/index.ts"
import { apiError } from "../util/errors.ts"

// Filenames we accept as a repo's README, in priority order. Mirrors
// the GitHub priority list. Case-insensitive match against the
// directory's tree entries.
const README_CANDIDATES = ["README.md", "README.MD", "Readme.md", "readme.md", "README", "README.markdown", "README.txt"]

// `auth` may be null on browse routes — public repos are readable
// without credentials. Returns the user's id when present, or null
// for anonymous callers.
const authIdOrNull = (c: any): number | null => {
  const a = c.assigns.auth as { id?: number } | null
  return a?.id ?? null
}

// The browse routes expose code in the bare repo to the SPA. They are
// strictly read-only — pushes still go through src/git/index.ts. We
// reuse the same access gate (read = clone) so private repos stay
// private and archived repos stay browseable.
//
// URL shape:
//   GET /repos/:owner/:name/refs                         — branch + tag list
//   GET /repos/:owner/:name/tree/:ref                    — root listing
//   GET /repos/:owner/:name/tree/:ref/*path              — listing under path
//   GET /repos/:owner/:name/blob/:ref/*path              — file contents
//
// `:ref` accepts a branch name, tag name, or a (full or short) SHA.

const PATH_MAX = 1024

const getSubPath = (params: Record<string, string>, request: Request, kind: "tree" | "blob"): string => {
  // The atlas router supports a single trailing wildcard. We register
  // `/repos/:owner/:name/<kind>/:ref/*` and `/repos/:owner/:name/<kind>/:ref`
  // so both rooted and pathed requests resolve cleanly.
  const url = new URL(request.url)
  const prefix = `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.name)}/${kind}/${encodeURIComponent(params.ref)}`
  let path = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : ""
  if (path.startsWith("/")) path = path.slice(1)
  return decodeURIComponent(path)
}

export const browseRoutes = (db: Connection, secret: string, repoDir: string) => {
  // Optional auth: anonymous callers can still browse public repos.
  // resolveRepoAccess(_, repo, null) returns readable for public,
  // hidden for private — same gate, soft-failure on missing token.
  const guard = pipeline(optionalAuth({ secret, db }))

  return [
    get("/repos/:owner/:name/refs", guard(async (c) => {
      const userId = authIdOrNull(c)
      const repo = await findRepo(db, c.params.owner, c.params.name)
      if (!repo) return apiError(c, "not_found", "Repo not found")
      const access = await resolveRepoAccess(db, repo, userId)
      if (!access.read) return apiError(c, "not_found", "Repo not found")
      const gitdir = resolveRepoPath(repoDir, repo.owner_login, repo.name)
      const refs = await listRefs(gitdir, repo.default_branch)
      return json(c, 200, refs)
    })),

    get("/repos/:owner/:name/tree/:ref", guard(treeHandler(db, repoDir, /*hasPath*/ false))),
    get("/repos/:owner/:name/tree/:ref/*", guard(treeHandler(db, repoDir, /*hasPath*/ true))),

    get("/repos/:owner/:name/blob/:ref", guard(blobHandler(db, repoDir, /*hasPath*/ false))),
    get("/repos/:owner/:name/blob/:ref/*", guard(blobHandler(db, repoDir, /*hasPath*/ true))),

    // Commit log. The query string carries `ref` (defaults to the
    // repo's default branch) and `page` for pagination. Page size is
    // fixed at 50 — the SPA fetches the next page on scroll if needed.
    get("/repos/:owner/:name/commits", guard(async (c) => {
      const userId = authIdOrNull(c)
      const repo = await findRepo(db, c.params.owner, c.params.name)
      if (!repo) return apiError(c, "not_found", "Repo not found")
      const access = await resolveRepoAccess(db, repo, userId)
      if (!access.read) return apiError(c, "not_found", "Repo not found")

      const gitdir = resolveRepoPath(repoDir, repo.owner_login, repo.name)
      const url = new URL(c.request.url)
      const refInput = (url.searchParams.get("ref") ?? "").trim() || repo.default_branch
      const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1)
      const pageSize = 50

      const resolved = await resolveBrowseRef(gitdir, refInput, repo.default_branch)
      if (!resolved) return json(c, 200, { ref: repo.default_branch, page, page_size: pageSize, commits: [] })

      const commits = await listCommits(gitdir, resolved.oid, {
        skip: (page - 1) * pageSize,
        depth: pageSize,
      })
      return json(c, 200, {
        ref: resolved.ref,
        commit: resolved.oid,
        page,
        page_size: pageSize,
        commits,
      })
    })),

    // Repo README, rendered. The SPA renders this at the bottom of the
    // Code tab landing. We always render against the default branch
    // unless `?ref=` is supplied. Empty/no-README repos return 200 with
    // null fields so the SPA can choose between "no readme" and "API
    // error" without a separate error path.
    get("/repos/:owner/:name/readme", guard(async (c) => {
      const userId = authIdOrNull(c)
      const repo = await findRepo(db, c.params.owner, c.params.name)
      if (!repo) return apiError(c, "not_found", "Repo not found")
      const access = await resolveRepoAccess(db, repo, userId)
      if (!access.read) return apiError(c, "not_found", "Repo not found")

      const gitdir = resolveRepoPath(repoDir, repo.owner_login, repo.name)
      const url = new URL(c.request.url)
      const refInput = (url.searchParams.get("ref") ?? "").trim() || repo.default_branch
      const resolved = await resolveBrowseRef(gitdir, refInput, repo.default_branch)
      if (!resolved) {
        return json(c, 200, { ref: refInput, path: null, text: null, html: null })
      }

      const root = await readTreePath(gitdir, resolved.oid, "")
      if (!root) return json(c, 200, { ref: resolved.ref, path: null, text: null, html: null })

      const lower = new Map(root.filter(e => e.type === "blob").map(e => [e.path.toLowerCase(), e.path]))
      let match: string | null = null
      for (const candidate of README_CANDIDATES) {
        const found = lower.get(candidate.toLowerCase())
        if (found) { match = found; break }
      }
      if (!match) return json(c, 200, { ref: resolved.ref, path: null, text: null, html: null })

      const blob = await readBlobPath(gitdir, resolved.oid, match)
      if (!blob || blob.isBinary) return json(c, 200, { ref: resolved.ref, path: match, text: null, html: null })
      // Only render markdown for the .md/.markdown variants — a plain
      // README.txt is shown as code, not parsed as markdown.
      const isMarkdown = /\.md$|\.markdown$/i.test(match)
      return json(c, 200, {
        ref: resolved.ref,
        path: match,
        text: blob.text ?? null,
        html: isMarkdown ? renderMarkdown(blob.text ?? "") : null,
      })
    })),
  ]
}

const treeHandler = (db: Connection, repoDir: string, hasPath: boolean) =>
  async (c: any) => {
    const userId = authIdOrNull(c)
    const repo = await findRepo(db, c.params.owner, c.params.name)
    if (!repo) return apiError(c, "not_found", "Repo not found")
    const access = await resolveRepoAccess(db, repo, userId)
    if (!access.read) return apiError(c, "not_found", "Repo not found")

    const gitdir = resolveRepoPath(repoDir, repo.owner_login, repo.name)
    const resolved = await resolveBrowseRef(gitdir, c.params.ref, repo.default_branch)
    if (!resolved) {
      // Empty repos — no commits yet — should not 404. Return a marker
      // so the SPA can render the "first commit" empty state.
      return json(c, 200, {
        empty: true,
        ref: repo.default_branch,
        path: "",
        entries: [],
      })
    }

    const path = hasPath ? getSubPath(c.params, c.request, "tree") : ""
    if (path.length > PATH_MAX) return apiError(c, "validation", "path too long")
    const entries = await readTreePath(gitdir, resolved.oid, path)
    if (entries === null) return apiError(c, "not_found", "Path not found at this ref")

    // Sort directories first, then files; alphabetical within each.
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === "tree" ? -1 : 1
      return a.path.localeCompare(b.path)
    })

    return json(c, 200, {
      ref: resolved.ref,
      kind: resolved.kind,
      commit: resolved.oid,
      path,
      entries,
    })
  }

const blobHandler = (db: Connection, repoDir: string, hasPath: boolean) =>
  async (c: any) => {
    const userId = authIdOrNull(c)
    const repo = await findRepo(db, c.params.owner, c.params.name)
    if (!repo) return apiError(c, "not_found", "Repo not found")
    const access = await resolveRepoAccess(db, repo, userId)
    if (!access.read) return apiError(c, "not_found", "Repo not found")

    const gitdir = resolveRepoPath(repoDir, repo.owner_login, repo.name)
    const resolved = await resolveBrowseRef(gitdir, c.params.ref, repo.default_branch)
    if (!resolved) return apiError(c, "not_found", "Ref not found")

    const path = hasPath ? getSubPath(c.params, c.request, "blob") : ""
    if (!path) return apiError(c, "validation", "blob path required")
    if (path.length > PATH_MAX) return apiError(c, "validation", "path too long")
    const blob = await readBlobPath(gitdir, resolved.oid, path)
    if (!blob) return apiError(c, "not_found", "Blob not found at this path")

    return json(c, 200, {
      ref: resolved.ref,
      commit: resolved.oid,
      path,
      oid: blob.oid,
      size: blob.size,
      is_binary: blob.isBinary,
      text: blob.text ?? null,
    })
  }
