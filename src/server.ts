import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { defineConfig, env } from "@atlas/config"
import { connect } from "@atlas/db"
import { migrate } from "@atlas/migrate"
import { router } from "@atlas/server"
import { authRoutes } from "./auth/index.ts"
import { sessionRoutes } from "./auth/sessions.ts"
import { userRoutes } from "./users/index.ts"
import { orgRoutes } from "./orgs/index.ts"
import { repoRoutes } from "./repos/index.ts"
import { collaboratorRoutes } from "./collaborators/index.ts"
import { sshKeyRoutes } from "./sshkeys/index.ts"
import { appRoutes } from "./apps/index.ts"
import { issueRoutes } from "./issues/index.ts"
import { pullRoutes } from "./pulls/index.ts"
import { commentRoutes } from "./comments/index.ts"
import { starRoutes } from "./stars/index.ts"
import { releaseRoutes } from "./releases/index.ts"
import { statusRoutes } from "./statuses/index.ts"
import { webhookRoutes } from "./webhooks/index.ts"
import { inviteRoutes } from "./invites/index.ts"
import { gitRoutes } from "./git/index.ts"
import { browseRoutes } from "./browse/index.ts"
import { searchRoutes } from "./search/index.ts"
import { labelRoutes } from "./labels/index.ts"
import { healthRoutes } from "./health/index.ts"
import { adminSettingsRoutes } from "./settings/index.ts"
import { adminMcpRoutes, mcpRoutes } from "./mcp/http.ts"
import { castleRoutes } from "./castle/index.ts"
import { setupTangleSso, ssoStatusRoutes } from "./sso/index.ts"

const maybeSsoRoutes = async (db: any, cfg: { ssoIssuer: string; ssoClientId: string; ssoClientSecret: string; secret: string }) => {
  if (!cfg.ssoIssuer || !cfg.ssoClientId || !cfg.ssoClientSecret) return []
  return setupTangleSso(db, {
    issuerUrl: cfg.ssoIssuer,
    clientId: cfg.ssoClientId,
    clientSecret: cfg.ssoClientSecret,
    secret: cfg.secret,
  })
}
import { createStorage } from "./storage/index.ts"
import { createEmailer } from "./email/index.ts"
import { withSecurityHeaders } from "./security/headers.ts"
import { sweepExpiredSessions } from "./security/sessions.ts"
import { sweepMirrors, sweepRepoSizes } from "./repos/sweep.ts"

const config = defineConfig({
  port: env("PORT", { parse: Number, default: "3000" }),
  secret: env("SECRET", { default: "dev-secret-change-me" }),
  databaseUrl: env("DATABASE_URL", { default: "postgres://postgres:postgres@localhost:5432/tangle" }),
  repoDir: env("REPO_DIR", { default: "./.tangle/repos" }),
  storageDriver: env("STORAGE_DRIVER", { default: "local" }),
  storageLocalDir: env("STORAGE_LOCAL_DIR", { default: "./.tangle/blobs" }),
  s3Endpoint: env("S3_ENDPOINT", { default: "http://localhost:4000" }),
  s3Bucket: env("S3_BUCKET", { default: "tangle" }),
  s3Region: env("S3_REGION", { default: "us-east-1" }),
  s3AccessKey: env("S3_ACCESS_KEY", { default: "tangleadmin" }),
  s3SecretKey: env("S3_SECRET_KEY", { default: "tangleadmin" }),
  appUrl: env("APP_URL", { default: "http://localhost:3001" }),
  resendApiKey: env("RESEND_API_KEY", { default: "" }),
  resendFrom: env("RESEND_FROM", { default: "Tangle <onboarding@resend.dev>" }),
  rpId: env("RP_ID", { default: "localhost" }),
  rpName: env("RP_NAME", { default: "Tangle" }),
  rpOrigin: env("RP_ORIGIN", { default: "http://localhost:3001" }),
  // Bun buffers the request body before the handler runs, so this is
  // also a memory ceiling per concurrent push. Git push packs come in
  // as one big body — sized to fit the largest pack we want to accept.
  maxUploadBytes: env("MAX_UPLOAD_BYTES", { parse: Number, default: String(1024 * 1024 * 1024) }),
  // Opt-in M2M token for Castle (single-node homelab control plane). When
  // set, /castle/* routes mount and accept this bearer for user provisioning.
  // When empty, the integration is invisible and Tangle runs unchanged.
  castleAdminToken: env("CASTLE_ADMIN_TOKEN", { default: "" }),
  // OIDC SSO. All three required together; any missing → integration off.
  ssoIssuer: env("SSO_ISSUER", { default: "" }),
  ssoClientId: env("SSO_CLIENT_ID", { default: "" }),
  ssoClientSecret: env("SSO_CLIENT_SECRET", { default: "" }),
})

const db = connect({ driver: "postgres", url: config.databaseUrl })
const repoDir = resolve(config.repoDir)
await mkdir(repoDir, { recursive: true })
const store = config.storageDriver === "local"
  ? createStorage({ driver: "local", dir: config.storageLocalDir })
  : createStorage({
      driver: "s3",
      endpoint: config.s3Endpoint,
      bucket: config.s3Bucket,
      region: config.s3Region,
      accessKey: config.s3AccessKey,
      secretKey: config.s3SecretKey,
    })
const emailer = createEmailer({
  apiKey: config.resendApiKey,
  from: config.resendFrom,
})

await migrate.up(db, "./migrations")

const ssoRoutes = await maybeSsoRoutes(db, config)

const fetch = router(
  ...authRoutes(db, config.secret),
  ...sessionRoutes(db, config.secret),
  ...userRoutes(db, config.secret, store),
  ...orgRoutes(db, config.secret),
  ...repoRoutes(db, config.secret, repoDir),
  ...collaboratorRoutes(db, config.secret),
  ...sshKeyRoutes(db, config.secret),
  ...appRoutes(db, config.secret),
  ...issueRoutes(db, config.secret),
  ...pullRoutes(db, config.secret, repoDir),
  ...commentRoutes(db, config.secret),
  ...starRoutes(db, config.secret),
  ...releaseRoutes(db, config.secret, store),
  ...statusRoutes(db, config.secret),
  ...webhookRoutes(db, config.secret),
  ...inviteRoutes(db, config.secret),
  ...gitRoutes(db, repoDir),
  ...browseRoutes(db, config.secret, repoDir),
  ...searchRoutes(db, config.secret, repoDir),
  ...labelRoutes(db, config.secret),
  ...healthRoutes(db),
  ...adminSettingsRoutes(db, config.secret),
  ...mcpRoutes({ db, secret: config.secret, store, repoDir, appUrl: config.appUrl }),
  ...adminMcpRoutes({ db, secret: config.secret, store, repoDir, appUrl: config.appUrl }),
  ...castleRoutes(db, config.castleAdminToken),
  ...ssoStatusRoutes(config),
  ...ssoRoutes,
)

// Periodic housekeeping. Each sweep is guarded so a slow run cannot
// stack onto itself and chew through the connection pool.
const guardedSweep = (label: string, fn: () => Promise<unknown>) => {
  let running = false
  return async () => {
    if (running) return
    running = true
    try { await fn() } catch (err) { console.error(`[tangle] sweep ${label} failed:`, err) }
    finally { running = false }
  }
}
const sweepSessions = guardedSweep("sessions", () => sweepExpiredSessions(db))
const mirrorSweep = guardedSweep("mirrors", () => sweepMirrors(db, repoDir))
const sizeSweep = guardedSweep("repo-sizes", () => sweepRepoSizes(db, repoDir))
setInterval(() => { void sweepSessions() }, 60 * 60 * 1000)
// Mirror sync every 15 minutes — short enough to feel responsive for
// active upstreams, long enough to be polite to GitHub/GitLab APIs.
setInterval(() => { void mirrorSweep() }, 15 * 60 * 1000)
// Repo size every hour — `du -sk` is cheap but it's not free.
setInterval(() => { void sizeSweep() }, 60 * 60 * 1000)
void sweepSessions()
void mirrorSweep()
void sizeSweep()

// Production refuses to start with the default SECRET — JWTs signed with
// a known value would be forgeable by anyone. In development we just
// warn so `bun run dev` works out of the box on a fresh clone. The
// emailer is also informational here; missing creds drop emails to the
// console (see src/email/index.ts).
const isDev = (process.env.NODE_ENV ?? "development") === "development"
if (config.secret === "dev-secret-change-me") {
  if (isDev) {
    console.warn("[tangle] WARNING: running with the default SECRET. Set a strong SECRET in .env before production.")
  } else {
    console.error("[tangle] FATAL: SECRET is set to its default value. Refusing to start. Set SECRET in your environment to a strong random string (e.g. `openssl rand -hex 32`).")
    process.exit(1)
  }
}
if (config.secret.length < 32 && !isDev) {
  console.error(`[tangle] FATAL: SECRET is too short (${config.secret.length} chars). Use at least 32 chars in production.`)
  process.exit(1)
}

Bun.serve({
  port: config.port,
  hostname: "0.0.0.0",
  fetch: withSecurityHeaders(fetch),
  maxRequestBodySize: config.maxUploadBytes,
  idleTimeout: 0,
})

console.log(`[tangle] api on http://localhost:${config.port}`)
console.log(`[tangle] repos: ${repoDir}`)
const storageInfo = config.storageDriver === "local"
  ? `local (${config.storageLocalDir})`
  : `s3 (${config.s3Endpoint})`
console.log(`[tangle] attachments: ${storageInfo}`)
if (!emailer.enabled) {
  console.log("[tangle] email: RESEND_API_KEY not set — outbound mail logs to the console")
}
