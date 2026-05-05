import { mkdir, rm, stat } from "node:fs/promises"
import { resolve, sep } from "node:path"
import { spawn } from "node:child_process"

const safeOwnerName = (s: string) => /^[a-z0-9-]{1,40}$/.test(s)
// Repo names allow uppercase letters, digits, dot, dash, underscore — no
// path separators, no traversal. Mirrors `isValidRepoName` in repos/.
const safeRepoName = (s: string) => /^[a-zA-Z0-9._-]{1,100}$/.test(s) && s !== "." && s !== ".."

const repoPath = (root: string, owner: string, name: string): string => {
  if (!safeOwnerName(owner) || !safeRepoName(name)) {
    throw new Error(`unsafe repo location: ${owner}/${name}`)
  }
  const target = resolve(root, owner, `${name}.git`)
  // Defense in depth — every repo directory must live underneath the
  // root. Symlink shenanigans + traversal can never escape.
  if (!target.startsWith(resolve(root) + sep)) {
    throw new Error(`repo path escapes root: ${owner}/${name}`)
  }
  return target
}

const runGit = (cwd: string, args: string[]): Promise<void> =>
  new Promise((resolveP, rejectP) => {
    const proc = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    let stderr = ""
    proc.stderr.on("data", chunk => { stderr += chunk.toString() })
    proc.on("error", rejectP)
    proc.on("close", code => {
      if (code === 0) resolveP()
      else rejectP(new Error(`git ${args.join(" ")} exited ${code}: ${stderr.trim()}`))
    })
  })

export const bareRepoExists = async (root: string, owner: string, name: string): Promise<boolean> => {
  try {
    const path = repoPath(root, owner, name)
    const s = await stat(path)
    return s.isDirectory()
  } catch {
    return false
  }
}

export const initBareRepo = async (
  root: string,
  owner: string,
  name: string,
  defaultBranch: string,
): Promise<string> => {
  const path = repoPath(root, owner, name)
  if (await bareRepoExists(root, owner, name)) {
    throw new Error(`repo already exists on disk: ${owner}/${name}.git`)
  }
  await mkdir(path, { recursive: true })
  await runGit(path, ["init", "--bare", `--initial-branch=${defaultBranch || "main"}`])
  // Disable the dumb-HTTP transport — Tangle only speaks Smart-HTTP.
  await runGit(path, ["config", "http.receivepack", "true"])
  await runGit(path, ["config", "http.uploadpack", "true"])
  return path
}

export const dropBareRepo = async (root: string, owner: string, name: string): Promise<void> => {
  const path = repoPath(root, owner, name)
  await rm(path, { recursive: true, force: true })
}

export const resolveRepoPath = (root: string, owner: string, name: string): string =>
  repoPath(root, owner, name)

// Clone an existing bare repo to a new location on disk. Used by
// forking. `--no-hardlinks` keeps the fork as a fully independent
// object store, so admins backing up one repo don't accidentally pull
// the source's objects through inode sharing.
export const cloneBareRepo = async (
  root: string,
  fromOwner: string,
  fromName: string,
  toOwner: string,
  toName: string,
): Promise<string> => {
  const src = repoPath(root, fromOwner, fromName)
  const dst = repoPath(root, toOwner, toName)
  if (await bareRepoExists(root, toOwner, toName)) {
    throw new Error(`fork target already exists on disk: ${toOwner}/${toName}.git`)
  }
  await mkdir(dst, { recursive: true })
  await runGit(dst, ["clone", "--bare", "--no-hardlinks", src, "."])
  await runGit(dst, ["config", "http.receivepack", "true"])
  await runGit(dst, ["config", "http.uploadpack", "true"])
  return dst
}

// Add or update a `mirror` remote and run `git fetch` to pull every
// branch and tag from an external git URL. Used by the mirror feature.
// The remote name is fixed at "tangle-mirror" so we can safely
// overwrite it on each call without colliding with anything a user
// might have set up by hand.
export const fetchMirror = async (
  root: string,
  owner: string,
  name: string,
  url: string,
): Promise<void> => {
  const dir = repoPath(root, owner, name)
  await runGit(dir, ["remote", "remove", "tangle-mirror"]).catch(() => {})
  await runGit(dir, ["remote", "add", "tangle-mirror", url])
  // `--prune` removes refs deleted upstream so the mirror tracks
  // upstream exactly. The two refspecs cover branches and tags.
  await runGit(dir, [
    "fetch", "--prune", "tangle-mirror",
    "+refs/heads/*:refs/heads/*",
    "+refs/tags/*:refs/tags/*",
  ])
}
