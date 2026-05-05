import * as fs from "node:fs"
import git from "isomorphic-git"

// Read-side wrappers around isomorphic-git for the bare repos Tangle
// stores on disk. Push/clone still go through the upstream git
// binaries (src/git/protocol.ts) — only browse/inspect operations
// route through here, where we don't need a working tree at all.

const fsAdapter = { promises: fs.promises }

export type GitTreeEntry = {
  path: string
  oid: string
  type: "blob" | "tree" | "commit"
  mode: string
}

export type GitBlob = {
  oid: string
  size: number
  isBinary: boolean
  text?: string  // UTF-8 decoded; omitted for binaries
}

export type GitCommit = {
  oid: string
  parents: string[]
  message: string
  author: { name: string; email: string; timestamp: number; timezoneOffset: number }
  committer: { name: string; email: string; timestamp: number; timezoneOffset: number }
}

export type GitRefList = {
  branches: Array<{ name: string; oid: string; isDefault: boolean }>
  tags: Array<{ name: string; oid: string }>
  default: string
}

const BINARY_PROBE_BYTES = 8000
const isProbablyBinary = (buf: Uint8Array): boolean => {
  const probe = buf.subarray(0, Math.min(buf.byteLength, BINARY_PROBE_BYTES))
  // The classic NUL-byte heuristic — git uses the same one.
  for (let i = 0; i < probe.length; i++) {
    if (probe[i] === 0) return true
  }
  return false
}

export const resolveRef = async (gitdir: string, ref: string): Promise<string | null> => {
  try {
    return await git.resolveRef({ fs: fsAdapter, gitdir, ref })
  } catch {
    return null
  }
}

// Resolve a "tree-ish" — branch name, tag name, or raw SHA — to a
// commit SHA. We try ref resolution first, then fall back to assuming
// the input is already a commit SHA.
export const resolveCommit = async (gitdir: string, treeish: string): Promise<string | null> => {
  const direct = await resolveRef(gitdir, treeish)
  if (direct) return direct
  // Last resort: treat as a literal SHA. expandOid handles abbreviated
  // SHAs and verifies the object exists.
  try {
    const full = await git.expandOid({ fs: fsAdapter, gitdir, oid: treeish })
    return full
  } catch {
    return null
  }
}

export const readCommit = async (gitdir: string, oid: string): Promise<GitCommit | null> => {
  try {
    const r = await git.readCommit({ fs: fsAdapter, gitdir, oid })
    return {
      oid: r.oid,
      parents: r.commit.parent,
      message: r.commit.message,
      author: r.commit.author,
      committer: r.commit.committer,
    }
  } catch {
    return null
  }
}

// Walk down a path under the commit's tree, returning the entries at
// that path. Empty `path` returns the root tree.
export const readTreePath = async (
  gitdir: string,
  commitOid: string,
  path: string,
): Promise<GitTreeEntry[] | null> => {
  const commit = await git.readCommit({ fs: fsAdapter, gitdir, oid: commitOid }).catch(() => null)
  if (!commit) return null
  let oid = commit.commit.tree
  const segments = path.split("/").filter(Boolean)
  for (const seg of segments) {
    const tree = await git.readTree({ fs: fsAdapter, gitdir, oid }).catch(() => null)
    if (!tree) return null
    const entry = tree.tree.find(e => e.path === seg)
    if (!entry || entry.type !== "tree") return null
    oid = entry.oid
  }
  const tree = await git.readTree({ fs: fsAdapter, gitdir, oid }).catch(() => null)
  if (!tree) return null
  return tree.tree.map(e => ({
    path: e.path,
    oid: e.oid,
    type: e.type as "blob" | "tree" | "commit",
    mode: e.mode,
  }))
}

// Resolve a path to a blob and return its bytes (decoded as UTF-8 when
// not binary). Used by the file viewer and README rendering.
export const readBlobPath = async (
  gitdir: string,
  commitOid: string,
  path: string,
): Promise<GitBlob | null> => {
  const commit = await git.readCommit({ fs: fsAdapter, gitdir, oid: commitOid }).catch(() => null)
  if (!commit) return null
  let oid = commit.commit.tree
  const segments = path.split("/").filter(Boolean)
  if (segments.length === 0) return null
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!
    const tree = await git.readTree({ fs: fsAdapter, gitdir, oid }).catch(() => null)
    if (!tree) return null
    const entry = tree.tree.find(e => e.path === seg)
    if (!entry) return null
    if (i === segments.length - 1) {
      if (entry.type !== "blob") return null
      const blob = await git.readBlob({ fs: fsAdapter, gitdir, oid: entry.oid }).catch(() => null)
      if (!blob) return null
      const bytes = blob.blob
      const binary = isProbablyBinary(bytes)
      return {
        oid: entry.oid,
        size: bytes.byteLength,
        isBinary: binary,
        text: binary ? undefined : new TextDecoder("utf-8", { fatal: false }).decode(bytes),
      }
    }
    if (entry.type !== "tree") return null
    oid = entry.oid
  }
  return null
}

export const listCommits = async (
  gitdir: string,
  ref: string,
  opts: { skip?: number; depth?: number } = {},
): Promise<GitCommit[]> => {
  const depth = opts.depth ?? 50
  const skip = opts.skip ?? 0
  // isomorphic-git's log gives a flat oldest-to-newest walk from the
  // ref; we apply skip + depth client-side. For deep histories an
  // explicit pagination cursor (last-seen oid) would be more efficient
  // but a per-ref `since` style cursor would also leak history shape.
  const log = await git.log({ fs: fsAdapter, gitdir, ref, depth: skip + depth }).catch(() => null)
  if (!log) return []
  return log.slice(skip, skip + depth).map(r => ({
    oid: r.oid,
    parents: r.commit.parent,
    message: r.commit.message,
    author: r.commit.author,
    committer: r.commit.committer,
  }))
}

export const listRefs = async (gitdir: string, defaultBranch: string): Promise<GitRefList> => {
  const [branches, tags] = await Promise.all([
    git.listBranches({ fs: fsAdapter, gitdir }).catch(() => [] as string[]),
    git.listTags({ fs: fsAdapter, gitdir }).catch(() => [] as string[]),
  ])
  const branchOids = await Promise.all(
    branches.map(async name => ({
      name,
      oid: (await resolveRef(gitdir, `refs/heads/${name}`)) ?? "",
      isDefault: name === defaultBranch,
    })),
  )
  const tagOids = await Promise.all(
    tags.map(async name => ({
      name,
      oid: (await resolveRef(gitdir, `refs/tags/${name}`)) ?? "",
    })),
  )
  return {
    branches: branchOids.filter(b => b.oid),
    tags: tagOids.filter(t => t.oid),
    default: defaultBranch,
  }
}

// Resolve a "ref or commit" input to (commitOid, refKind). Used by the
// browse routes to disambiguate the URL path; callers pass either a
// branch name, a tag, or a SHA, and we figure it out.
export const resolveBrowseRef = async (
  gitdir: string,
  input: string,
  defaultBranch: string,
): Promise<{ ref: string; oid: string; kind: "branch" | "tag" | "commit" } | null> => {
  const target = input || defaultBranch
  // Try as a branch first, then a tag, then a commit SHA.
  const branchOid = await resolveRef(gitdir, `refs/heads/${target}`)
  if (branchOid) return { ref: target, oid: branchOid, kind: "branch" }
  const tagOid = await resolveRef(gitdir, `refs/tags/${target}`)
  if (tagOid) return { ref: target, oid: tagOid, kind: "tag" }
  const commitOid = await resolveCommit(gitdir, target)
  if (commitOid) return { ref: target, oid: commitOid, kind: "commit" }
  return null
}
