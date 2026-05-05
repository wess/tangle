import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { get, json } from "@atlas/server"

// Tangle's version banner. Static at build time — picks up from
// `package.json` via Bun's JSON import. The same string is exposed on
// the /version endpoint and embedded in webhook user-agents so
// downstream tooling can correlate.
import pkg from "../../package.json" with { type: "json" }

export const VERSION: string = (pkg as { version?: string }).version ?? "0.0.0"

// /health probes Postgres and returns a structured payload that load
// balancers, k8s liveness probes, and our own MCP server can rely on.
// Returns 200 when healthy, 503 when the db round-trip fails.
export const healthRoutes = (db: Connection) => [
  get("/health", async (c) => {
    const started = Date.now()
    try {
      await db.one(from("users").select("id").limit(1))
      return json(c, 200, {
        status: "ok",
        version: VERSION,
        db_latency_ms: Date.now() - started,
      })
    } catch (err) {
      return json(c, 503, {
        status: "degraded",
        version: VERSION,
        db_latency_ms: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }),

  get("/version", async (c) =>
    json(c, 200, { version: VERSION, name: "tangle" }),
  ),
]
