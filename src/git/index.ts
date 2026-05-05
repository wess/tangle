import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { get, halt, post, putHeader, setStatus, stream } from "@atlas/server"
import type { Conn } from "@atlas/server"
import { hashToken, APP_TOKEN_PREFIX } from "../auth/guard.ts"
import { findRepo, resolveRepoAccess } from "../permissions/index.ts"
import { dispatchWebhook } from "../webhooks/dispatch.ts"
import { runAdvertise, runRpc } from "./protocol.ts"
import { resolveRepoPath } from "./repo.ts"

// Smart-HTTP routes mount at the root namespace, NOT under /api — `git
// clone` builds the URL as `<base>/<owner>/<repo>.git` directly. The
// reverse proxy (caddyfile) sends matching paths straight to the API.
//
// The atlas router is segment-strict and can't put `.git` inline in a
// pattern segment, so we register `/:owner/:repo/...` and require
// `:repo` to end with `.git` inside each handler. Anything else 404s.

type AuthResult =
  | { ok: true; userId: number; scopes: string[] }
  | { ok: false }

const tryBasicAuth = async (db: Connection, header: string | null): Promise<AuthResult> => {
  if (!header || !header.startsWith("Basic ")) return { ok: false }
  let decoded: string
  try { decoded = atob(header.slice(6).trim()) } catch { return { ok: false } }
  const sep = decoded.indexOf(":")
  if (sep < 0) return { ok: false }
  const _user = decoded.slice(0, sep)
  const pass = decoded.slice(sep + 1)
  // Only PATs are accepted on the git wire — passwords would force us
  // to bcrypt-verify on every push. Users provide their PAT as the
  // password and any string as the username.
  if (!pass.startsWith(APP_TOKEN_PREFIX)) return { ok: false }
  const tokenHash = hashToken(pass)
  const app = await db.one(
    from("apps").where(q => q("token_hash").equals(tokenHash)).select("id", "user_id", "scopes"),
  ) as { id: number; user_id: number; scopes: string } | null
  if (!app) return { ok: false }
  void db.execute(
    from("apps").where(q => q("id").equals(app.id)).update({ last_used_at: raw("NOW()") }),
  ).catch(() => {})
  const scopes = (app.scopes ?? "").split(/\s+/).filter(Boolean)
  return { ok: true, userId: app.user_id, scopes }
}

// `repo` and `admin` grant write; `repo:write` is the explicit
// write-only scope. Read-only PATs (`repo:read`) cannot push.
const canPush = (scopes: string[]): boolean =>
  scopes.includes("repo") || scopes.includes("repo:write") || scopes.includes("admin")

const stripDotGit = (s: string): string | null => s.endsWith(".git") ? s.slice(0, -4) : null

const unauthorized = (c: Conn): Conn => {
  const withHeader = putHeader(c, "www-authenticate", 'Basic realm="tangle"')
  return halt(setStatus(withHeader, 401), 401, "Authentication required")
}

const notFound = (c: Conn): Conn => halt(setStatus(c, 404), 404, "not found")
const forbidden = (c: Conn): Conn => halt(setStatus(c, 403), 403, "forbidden")

const NO_CACHE: Array<[string, string]> = [
  ["cache-control", "no-cache, max-age=0, must-revalidate"],
  ["pragma", "no-cache"],
  ["expires", "Fri, 01 Jan 1980 00:00:00 GMT"],
]

const withNoCache = (c: Conn): Conn => NO_CACHE.reduce((acc, [k, v]) => putHeader(acc, k, v), c)

const bytesToStream = (bytes: Uint8Array): ReadableStream =>
  new Blob([bytes as BlobPart]).stream()

export const gitRoutes = (db: Connection, repoDir: string) => [
  // GET /<owner>/<repo>.git/info/refs?service=git-upload-pack
  get("/:owner/:repo/info/refs", async (c) => {
    const repoName = stripDotGit(c.params.repo)
    if (!repoName) return notFound(c)
    const url = new URL(c.request.url)
    const service = url.searchParams.get("service")
    if (service !== "git-upload-pack" && service !== "git-receive-pack") {
      return halt(setStatus(c, 400), 400, "only smart-http is supported")
    }
    const repo = await findRepo(db, c.params.owner, repoName)
    if (!repo) return notFound(c)

    let userId: number | null = null
    let scopes: string[] = []
    const auth = await tryBasicAuth(db, c.headers.get("authorization"))
    if (auth.ok) { userId = auth.userId; scopes = auth.scopes }

    const access = await resolveRepoAccess(db, repo, userId)
    const wantWrite = service === "git-receive-pack"
    if (wantWrite ? !access.write : !access.read) {
      // Public repos are readable without creds — only force a 401 if
      // the caller is unauthenticated. Authenticated-but-forbidden gets
      // a 403 instead so retrying with creds doesn't loop.
      if (userId === null) return unauthorized(c)
      return forbidden(c)
    }
    // Scope check: a read-only PAT can advertise but not negotiate a
    // push. The receive-pack RPC is gated separately below; this gate
    // saves an unnecessary advertise round-trip when the token is
    // mis-scoped.
    if (wantWrite && userId !== null && !canPush(scopes)) {
      return forbidden(c)
    }

    const repoPath = resolveRepoPath(repoDir, repo.owner_login, repo.name)
    const body = await runAdvertise(service, repoPath)
    const ct = `application/x-${service}-advertisement`
    return stream(
      withNoCache(putHeader(setStatus(c, 200), "content-type", ct)),
      200,
      bytesToStream(body),
    )
  }),

  // POST /<owner>/<repo>.git/git-upload-pack — clone / fetch RPC
  post("/:owner/:repo/git-upload-pack", async (c) => {
    const repoName = stripDotGit(c.params.repo)
    if (!repoName) return notFound(c)
    const repo = await findRepo(db, c.params.owner, repoName)
    if (!repo) return notFound(c)

    let userId: number | null = null
    const auth = await tryBasicAuth(db, c.headers.get("authorization"))
    if (auth.ok) userId = auth.userId

    const access = await resolveRepoAccess(db, repo, userId)
    if (!access.read) {
      if (userId === null) return unauthorized(c)
      return forbidden(c)
    }

    const repoPath = resolveRepoPath(repoDir, repo.owner_login, repo.name)
    const result = await runRpc("git-upload-pack", repoPath, c.request)
    return stream(
      withNoCache(putHeader(setStatus(c, result.status), "content-type", result.contentType)),
      result.status,
      bytesToStream(result.body),
    )
  }),

  // POST /<owner>/<repo>.git/git-receive-pack — push RPC
  post("/:owner/:repo/git-receive-pack", async (c) => {
    const repoName = stripDotGit(c.params.repo)
    if (!repoName) return notFound(c)
    const repo = await findRepo(db, c.params.owner, repoName)
    if (!repo) return notFound(c)

    const auth = await tryBasicAuth(db, c.headers.get("authorization"))
    if (!auth.ok) return unauthorized(c)
    if (!canPush(auth.scopes)) return forbidden(c)

    const access = await resolveRepoAccess(db, repo, auth.userId)
    if (!access.write) return forbidden(c)

    const repoPath = resolveRepoPath(repoDir, repo.owner_login, repo.name)
    const result = await runRpc("git-receive-pack", repoPath, c.request)

    // Stamp pushed_at on success so the dashboard sorts recently-pushed
    // repos to the top. The on-disk size sweep can update size_bytes
    // separately rather than crawling the pack here.
    void db.execute(
      from("repos").where(q => q("id").equals(repo.id)).update({ pushed_at: raw("NOW()") }),
    ).catch(() => {})

    // Fire `push` webhooks. We don't have per-ref information here
    // because Smart-HTTP wraps the receive-pack in a black box, so the
    // payload is intentionally minimal — receivers that need ref/sha
    // detail can query the API for refs/commits afterwards.
    dispatchWebhook(db, repo.id, "push", {
      event: "push",
      repository: { id: repo.id, owner: repo.owner_login, name: repo.name },
      pushed_by: { id: auth.userId },
      pushed_at: new Date().toISOString(),
    })

    return stream(
      withNoCache(putHeader(setStatus(c, result.status), "content-type", result.contentType)),
      result.status,
      bytesToStream(result.body),
    )
  }),
]
