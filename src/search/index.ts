import type { Connection } from "@atlas/db"
import { get, json, pipeline } from "@atlas/server"
import { optionalAuth } from "../auth/guard.ts"
import { findRepo, resolveRepoAccess } from "../permissions/index.ts"
import { resolveRepoPath } from "../git/repo.ts"
import { resolveBrowseRef } from "../git/read.ts"
import { apiError } from "../util/errors.ts"

// Code search over a single bare repo, backed by `git grep`. We shell
// out to the git binary that is already a hard dependency of the server
// (clone/push/fork all use it) rather than introduce a separate search
// index. The query is passed as a single argv element via Bun.spawn —
// never string-interpolated into a shell — so a query of `; rm -rf /`
// is just a literal pattern git grep looks for.
//
// Results are grouped by file and capped to keep a pathological query
// (e.g. a single space matching every line) from streaming megabytes
// back to the SPA. The cap state is reported so the UI can show a
// "results truncated" notice.

const MAX_LINES = 200
const MAX_FILES = 50
// Hard ceiling on the pattern length. git grep itself is fine with long
// patterns, but there's no reason to accept an unbounded query string.
const QUERY_MAX = 512

export type SearchHit = { line: number; text: string }
export type SearchFile = { file: string; hits: SearchHit[] }
export type SearchResult = {
  query: string
  ref: string
  commit: string
  files: SearchFile[]
  total_lines: number
  total_files: number
  truncated: boolean
}

// Run `git grep` against a committish in a bare repo and parse the
// `file:line:text` output into per-file groups. Lines/files are capped;
// `truncated` is set when either cap is hit. Returns null when the ref
// cannot be resolved (empty repo / unknown ref) so the caller can 404.
export const gitGrep = async (
  gitdir: string,
  commit: string,
  query: string,
): Promise<{ files: SearchFile[]; totalLines: number; totalFiles: number; truncated: boolean }> => {
  // `-I` skips binary files, `-n` adds line numbers, `--fixed-strings`
  // treats the query literally (no regex surprises from user input),
  // `-e <query>` keeps the pattern as its own argv element so a leading
  // `-` in the query can't be read as a flag. `--no-color` keeps the
  // output machine-parseable.
  const proc = Bun.spawn(
    [
      "git",
      `--git-dir=${gitdir}`,
      "grep",
      "--no-color",
      "-I",
      "-n",
      "--fixed-strings",
      "-e",
      query,
      commit,
    ],
    { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  )

  const stdout = await new Response(proc.stdout).text()
  const code = await proc.exited
  // git grep exits 1 when there are simply no matches — that is not an
  // error, it's an empty result. Any other non-zero code (2+) is a real
  // failure (bad ref, unreadable repo) and we surface it as empty too,
  // since the route has already validated the ref.
  if (code !== 0 && code !== 1) {
    return { files: [], totalLines: 0, totalFiles: 0, truncated: false }
  }

  const byFile = new Map<string, SearchHit[]>()
  let totalLines = 0
  let truncated = false

  for (const raw of stdout.split("\n")) {
    if (!raw) continue
    if (totalLines >= MAX_LINES) {
      truncated = true
      break
    }
    // Output shape with a committish is `commit:path:line:text`. Without
    // a committish it's `path:line:text`. We always pass a commit, so
    // strip the leading `<commit>:` segment first, then split the rest.
    const afterCommit = raw.startsWith(`${commit}:`) ? raw.slice(commit.length + 1) : raw
    const firstColon = afterCommit.indexOf(":")
    if (firstColon < 0) continue
    const file = afterCommit.slice(0, firstColon)
    const rest = afterCommit.slice(firstColon + 1)
    const secondColon = rest.indexOf(":")
    if (secondColon < 0) continue
    const lineNo = Number.parseInt(rest.slice(0, secondColon), 10)
    if (!Number.isFinite(lineNo)) continue
    const text = rest.slice(secondColon + 1)

    if (!byFile.has(file)) {
      if (byFile.size >= MAX_FILES) {
        truncated = true
        break
      }
      byFile.set(file, [])
    }
    byFile.get(file)!.push({ line: lineNo, text })
    totalLines++
  }

  const files: SearchFile[] = [...byFile.entries()].map(([file, hits]) => ({ file, hits }))
  return { files, totalLines, totalFiles: files.length, truncated }
}

export const searchRoutes = (db: Connection, secret: string, repoDir: string) => {
  // Optional auth, identical to the browse routes: anonymous callers may
  // search public repos, private repos stay hidden behind the same gate.
  const guard = pipeline(optionalAuth({ secret, db }))

  return [
    // GET /repos/:owner/:name/search?q=...&ref=...
    //
    // Runs git grep on the default branch (or `?ref=`) and returns hits
    // grouped by file. Enforces repo read access exactly like the
    // file-browsing routes — a private repo answers "not found" to a
    // caller without read.
    get("/repos/:owner/:name/search", guard(async (c) => {
      const a = c.assigns.auth as { id?: number } | null
      const userId = a?.id ?? null

      const repo = await findRepo(db, c.params.owner, c.params.name)
      if (!repo) return apiError(c, "not_found", "Repo not found")
      const access = await resolveRepoAccess(db, repo, userId)
      if (!access.read) return apiError(c, "not_found", "Repo not found")

      const url = new URL(c.request.url)
      const query = (url.searchParams.get("q") ?? "").trim()
      if (!query) return apiError(c, "validation", "q is required")
      if (query.length > QUERY_MAX) return apiError(c, "validation", "q too long")

      const refInput = (url.searchParams.get("ref") ?? "").trim() || repo.default_branch
      const gitdir = resolveRepoPath(repoDir, repo.owner_login, repo.name)
      const resolved = await resolveBrowseRef(gitdir, refInput, repo.default_branch)
      if (!resolved) {
        // Empty repo / unknown ref: an empty, non-truncated result so
        // the SPA renders "no matches" rather than an error.
        return json(c, 200, {
          query,
          ref: repo.default_branch,
          commit: "",
          files: [],
          total_lines: 0,
          total_files: 0,
          truncated: false,
        } satisfies SearchResult)
      }

      const { files, totalLines, totalFiles, truncated } = await gitGrep(gitdir, resolved.oid, query)
      return json(c, 200, {
        query,
        ref: resolved.ref,
        commit: resolved.oid,
        files,
        total_lines: totalLines,
        total_files: totalFiles,
        truncated,
      } satisfies SearchResult)
    })),
  ]
}
