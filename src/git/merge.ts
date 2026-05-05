import { spawn } from "node:child_process"

// Minimal merge surface for PRs. v1 is fast-forward only — if the base
// is not an ancestor of the head, we refuse and tell the user to
// rebase or merge locally and push. The bigger merge story (3-way
// merge with conflict reporting, squash, rebase-and-merge) can layer
// on top of this without changing the public route shape.

const runGit = (cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> =>
  new Promise((resolveP) => {
    const proc = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    proc.stdout.on("data", chunk => { stdout += chunk.toString() })
    proc.stderr.on("data", chunk => { stderr += chunk.toString() })
    proc.on("error", () => resolveP({ stdout, stderr, code: -1 }))
    proc.on("close", code => resolveP({ stdout, stderr, code: code ?? -1 }))
  })

export type DiffSummary = {
  baseSha: string
  headSha: string
  files: number
  additions: number
  deletions: number
  patch: string
}

// Resolve a branch name to its SHA in a bare repo. Returns null if the
// ref is missing — the caller decides what to do (404, rebase prompt).
export const resolveBranchSha = async (gitdir: string, branch: string): Promise<string | null> => {
  const r = await runGit(gitdir, ["rev-parse", `refs/heads/${branch}`])
  if (r.code !== 0) return null
  return r.stdout.trim() || null
}

// True when `base` is an ancestor of `head` — i.e. fast-forward is
// possible. `git merge-base --is-ancestor` exits 0 for true, 1 for
// false, anything else is an error.
export const isAncestor = async (gitdir: string, base: string, head: string): Promise<boolean> => {
  const r = await runGit(gitdir, ["merge-base", "--is-ancestor", base, head])
  return r.code === 0
}

export const mergeBase = async (gitdir: string, a: string, b: string): Promise<string | null> => {
  const r = await runGit(gitdir, ["merge-base", a, b])
  if (r.code !== 0) return null
  return r.stdout.trim() || null
}

// Unified diff between two commits. We cap output at ~2 MB so a
// monster PR can't blow up an API response — receivers should fall
// back to viewing the patch via git CLI for huge changes.
const PATCH_CAP_BYTES = 2 * 1024 * 1024

export const diffBetween = async (gitdir: string, base: string, head: string): Promise<DiffSummary | null> => {
  const stat = await runGit(gitdir, ["diff", "--shortstat", `${base}..${head}`])
  if (stat.code !== 0) return null

  // `git diff --shortstat` output looks like:
  //   "  3 files changed, 21 insertions(+), 4 deletions(-)"
  // Any of the three numbers can be omitted depending on the change
  // mix (e.g. an addition-only change has no "deletions" segment).
  const m = stat.stdout
  const files = Number(m.match(/(\d+) files? changed/)?.[1] ?? "0")
  const additions = Number(m.match(/(\d+) insertions?/)?.[1] ?? "0")
  const deletions = Number(m.match(/(\d+) deletions?/)?.[1] ?? "0")

  const patch = await runGit(gitdir, ["diff", `${base}..${head}`])
  if (patch.code !== 0) return null
  const truncated = patch.stdout.length > PATCH_CAP_BYTES
    ? patch.stdout.slice(0, PATCH_CAP_BYTES) + "\n…(diff truncated; clone the repo to view in full)"
    : patch.stdout

  return {
    baseSha: base,
    headSha: head,
    files,
    additions,
    deletions,
    patch: truncated,
  }
}

export type MergeResult =
  | { ok: true; sha: string; mode: "fast-forward" }
  | { ok: false; reason: "not-ancestor" }
  | { ok: false; reason: "missing-ref" }
  | { ok: false; reason: "ref-update-failed"; detail: string }

// Fast-forward `<refs/heads/baseBranch>` to `headSha`. The bare repo
// is mutated in place. If the FF condition fails, we return without
// touching anything — receivers can prompt the user to rebase.
export const fastForwardMerge = async (
  gitdir: string,
  baseBranch: string,
  headSha: string,
): Promise<MergeResult> => {
  const baseSha = await resolveBranchSha(gitdir, baseBranch)
  if (!baseSha) return { ok: false, reason: "missing-ref" }
  if (!(await isAncestor(gitdir, baseSha, headSha))) return { ok: false, reason: "not-ancestor" }

  // `git update-ref` is the bare-repo-safe way to move a ref. Pass the
  // current SHA as the `oldvalue` to refuse the update if someone else
  // moved the ref between our check and write — closes the obvious
  // race window without taking a global lock.
  const r = await runGit(gitdir, ["update-ref", `refs/heads/${baseBranch}`, headSha, baseSha])
  if (r.code !== 0) {
    return { ok: false, reason: "ref-update-failed", detail: r.stderr.trim() || `exit ${r.code}` }
  }
  return { ok: true, sha: headSha, mode: "fast-forward" }
}
