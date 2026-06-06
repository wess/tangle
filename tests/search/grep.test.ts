import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Connection } from "@atlas/db"
import { gitGrep } from "../../src/search/index.ts"
import { resolveRepoAccess, type RepoRow } from "../../src/permissions/index.ts"

// Seed a real bare repo on disk by initialising a working clone, adding
// files, committing, then pushing into the bare. gitGrep runs against
// the bare's committish, exactly as the route does.

const run = async (cwd: string, args: string[]): Promise<void> => {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "ignore",
    stderr: "pipe",
    stdin: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  })
  const code = await proc.exited
  if (code !== 0) {
    const err = await new Response(proc.stderr).text()
    throw new Error(`git ${args.join(" ")} exited ${code}: ${err}`)
  }
}

let root: string
let bareDir: string
let commit: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "tangle-search-"))
  bareDir = join(root, "repo.git")
  const workDir = join(root, "work")

  await run(root, ["init", "--bare", "--initial-branch=main", bareDir])
  await run(root, ["init", "--initial-branch=main", workDir])
  await writeFile(join(workDir, "alpha.ts"), "export const needle = 1\nconst other = 2\n")
  await writeFile(join(workDir, "beta.ts"), "// nothing relevant here\nconst needle = 'found'\n")
  await writeFile(join(workDir, "gamma.md"), "# docs\nno match in this one\n")
  await run(workDir, ["add", "."])
  await run(workDir, ["commit", "-m", "seed"])
  await run(workDir, ["remote", "add", "origin", bareDir])
  await run(workDir, ["push", "origin", "main"])

  const proc = Bun.spawn(["git", `--git-dir=${bareDir}`, "rev-parse", "main"], {
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  })
  commit = (await new Response(proc.stdout).text()).trim()
  await proc.exited
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("gitGrep", () => {
  test("returns hits grouped by file", async () => {
    const result = await gitGrep(bareDir, commit, "needle")
    expect(result.totalFiles).toBe(2)
    const files = result.files.map((f) => f.file).sort()
    expect(files).toEqual(["alpha.ts", "beta.ts"])
    const alpha = result.files.find((f) => f.file === "alpha.ts")!
    expect(alpha.hits[0]!.line).toBe(1)
    expect(alpha.hits[0]!.text).toContain("needle")
    expect(result.truncated).toBe(false)
  })

  test("returns an empty result for a term with no matches", async () => {
    const result = await gitGrep(bareDir, commit, "zzz_no_such_token_zzz")
    expect(result.totalFiles).toBe(0)
    expect(result.totalLines).toBe(0)
    expect(result.files).toEqual([])
  })

  test("treats the query as a literal string, not a regex or shell", async () => {
    // A query with regex/shell metacharacters must match nothing here
    // rather than blow up or be interpreted — it is passed as one argv
    // element to git grep --fixed-strings.
    const result = await gitGrep(bareDir, commit, "needle; rm -rf /")
    expect(result.totalFiles).toBe(0)
  })
})

// The route reuses resolveRepoAccess (the file-browsing gate) before
// ever touching the repo on disk. This asserts the rejection path: a
// private repo denies read to an unrelated user, so the route would
// answer "not found" without running git grep.
const stubDb = (): Connection =>
  ({
    one: async () => null,
  }) as unknown as Connection

const privateRepo: RepoRow = {
  id: 1,
  owner_kind: "user",
  owner_id: 10,
  owner_login: "alice",
  name: "secret",
  description: null,
  is_private: true,
  default_branch: "main",
  is_archived: false,
  deleted_at: null,
}

describe("search permission gate", () => {
  test("private repo denies read to an unrelated user", async () => {
    const access = await resolveRepoAccess(stubDb(), privateRepo, 99)
    expect(access.read).toBe(false)
  })

  test("private repo denies read to anonymous callers", async () => {
    const access = await resolveRepoAccess(stubDb(), privateRepo, null)
    expect(access.read).toBe(false)
  })

  test("private repo owner keeps read", async () => {
    const access = await resolveRepoAccess(stubDb(), privateRepo, 10)
    expect(access.read).toBe(true)
  })
})
