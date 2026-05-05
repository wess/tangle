import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { defineConfig, env } from "@atlas/config"
import { connect } from "@atlas/db"
import { collectTools, createContext, createMcpServer } from "@atlas/mcp"
import { migrate } from "@atlas/migrate"
import { createStorage } from "../storage/index.ts"
import { resolveMcpUser, tangleTools } from "./index.ts"

// `bun src/mcp/serve.ts` — Tangle's MCP server. Talks JSON-RPC over
// stdio (LSP-style framing). Reuses the API process's config so a
// single .env governs both. Skips Bun.serve entirely; this is a pure
// stdio server intended for the operator's local AI assistant.

const config = defineConfig({
  databaseUrl: env("DATABASE_URL", { default: "postgres://postgres:postgres@localhost:5432/tangle" }),
  repoDir: env("REPO_DIR", { default: "./.tangle/repos" }),
  storageDriver: env("STORAGE_DRIVER", { default: "local" }),
  storageLocalDir: env("STORAGE_LOCAL_DIR", { default: "./.tangle/blobs" }),
  s3Endpoint: env("S3_ENDPOINT", { default: "http://localhost:4000" }),
  s3Bucket: env("S3_BUCKET", { default: "tangle" }),
  s3Region: env("S3_REGION", { default: "us-east-1" }),
  s3AccessKey: env("S3_ACCESS_KEY", { default: "tangleadmin" }),
  s3SecretKey: env("S3_SECRET_KEY", { default: "tangleadmin" }),
  // Optional override — set to a username/email to scope the MCP, or
  // "anonymous" to make it browse only public data. Default: instance
  // owner.
  mcpUser: env("TANGLE_MCP_USER", { default: "" }),
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

// Best-effort: the API process should run migrations, but if the MCP
// boots first we don't want it crashing on stale schema. Safe to run
// concurrently — atlas-migrate takes an advisory lock.
await migrate.up(db, "./migrations").catch((err) => {
  console.error(`[tangle-mcp] migration check failed: ${err}`)
})

const user = await resolveMcpUser(db, config.mcpUser ? config.mcpUser : null)
const tangleCtx = {
  db,
  store,
  repoDir,
  userId: user?.id ?? null,
  user,
}

// Atlas's built-ins (db.query, migrate.*, health.check, etc.) come for
// free — collectTools() picks them up from the AtlasMcpContext. Our
// domain tools layer on top.
const atlasCtx = createContext({ db, migrationsDir: "./migrations" })
const builtIns = collectTools(atlasCtx)
const ours = tangleTools(tangleCtx)

const server = createMcpServer([...builtIns, ...ours], atlasCtx)

// Identity banner on stderr — JSON-RPC framing keeps stdout clean for
// protocol traffic, so all human-readable diagnostics go to stderr.
const identity = user ? `${user.username} (id=${user.id}${user.is_owner ? ", owner" : ""})` : "anonymous"
console.error(`[tangle-mcp] ready — acting as ${identity}, ${ours.length} domain tools + ${builtIns.length} built-ins`)

await server.start()
