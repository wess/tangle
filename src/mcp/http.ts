import type { Connection } from "@atlas/db"
import { collectTools, createContext, createMcpServer, type Tool } from "@atlas/mcp"
import { get, json, parseJson, pipeline, post } from "@atlas/server"
import { requireAuth } from "../auth/guard.ts"
import { ownerOnly } from "../security/owner.ts"
import { mcpEnabled, mcpToolEnabled } from "../settings/index.ts"
import type { StorageHandle } from "../storage/index.ts"
import { loadMcpUserById, type TangleMcpContext } from "./context.ts"
import { tangleTools } from "./index.ts"

// HTTP transport for Tangle's MCP. The stdio server in src/mcp/serve.ts
// remains for local operator use; this exposes the same tools over a
// bearer-authenticated POST /mcp so remote AI clients (Claude Desktop, IDEs)
// can talk to a deployed Tangle. Per-category gating mirrors stohr — owners
// toggle `mcp_enabled` plus `mcp_tool_{read,write,delete}` from
// /admin/settings without restarting the API.

const PROTOCOL_VERSION = "2024-11-05"
const SERVER_NAME = "tangle-mcp"
const SERVER_VERSION = "0.1.0"

type Category = "read" | "write" | "delete"

// Explicit map: every tool's category is decided here, not inferred from
// the name, so a new tool added without a CATEGORY entry will be filtered
// out (safer than silently exposing it as read).
const CATEGORY: Record<string, Category> = {
  "tangle.git.blob": "read",
  "tangle.git.clone_url": "read",
  "tangle.git.commits": "read",
  "tangle.git.readme": "read",
  "tangle.git.refs": "read",
  "tangle.git.tree": "read",
  "tangle.issues.comment": "write",
  "tangle.issues.create": "write",
  "tangle.issues.get": "read",
  "tangle.issues.list": "read",
  "tangle.issues.list_comments": "read",
  "tangle.issues.update": "write",
  "tangle.labels.create": "write",
  "tangle.labels.list": "read",
  "tangle.pulls.comment": "write",
  "tangle.pulls.create": "write",
  "tangle.pulls.diff": "read",
  "tangle.pulls.get": "read",
  "tangle.pulls.list": "read",
  "tangle.pulls.merge": "write",
  "tangle.releases.list": "read",
  "tangle.repos.create": "write",
  "tangle.repos.delete": "delete",
  "tangle.repos.fork": "write",
  "tangle.repos.get": "read",
  "tangle.repos.list_by_owner": "read",
  "tangle.repos.list_mine": "read",
  "tangle.repos.set_mirror": "write",
  "tangle.users.me": "read",
  "tangle.users.search": "read",
  "tangle.webhooks.deliveries": "read",
  "tangle.webhooks.list": "read",
}

// Atlas's built-in tools (db.query, migrate.*, health.*, …) are all
// read-only inspection helpers, so they fall into the read bucket.
const ATLAS_BUILTIN_CATEGORY: Category = "read"

const enabledCategories = async (db: Connection): Promise<Set<Category>> => {
  const cats = new Set<Category>()
  if (await mcpToolEnabled(db, "read")) cats.add("read")
  if (await mcpToolEnabled(db, "write")) cats.add("write")
  if (await mcpToolEnabled(db, "delete")) cats.add("delete")
  return cats
}

const filterByCategory = (tools: Tool[], cats: Set<Category>, fallback: Category): Tool[] =>
  tools.filter(t => cats.has(CATEGORY[t.name] ?? fallback))

const authId = (c: any) => (c.assigns.auth as { id: number }).id

type HttpMcpDeps = {
  db: Connection
  secret: string
  store: StorageHandle
  repoDir: string
  appUrl: string
}

export const mcpRoutes = (deps: HttpMcpDeps) => {
  const { db, secret, store, repoDir, appUrl } = deps
  const guard = pipeline(requireAuth({ secret, db }), parseJson)

  return [
    // Unauthenticated discovery — AI clients (and the admin UI) hit this
    // to confirm MCP is on and learn the endpoint.
    get("/mcp", async (c) => {
      const enabled = await mcpEnabled(db)
      const cats = {
        read: await mcpToolEnabled(db, "read"),
        write: await mcpToolEnabled(db, "write"),
        delete: await mcpToolEnabled(db, "delete"),
      }
      return json(c, 200, {
        enabled,
        endpoint: `${appUrl.replace(/\/$/, "")}/mcp`,
        protocol_version: PROTOCOL_VERSION,
        server: { name: SERVER_NAME, version: SERVER_VERSION },
        categories: cats,
        auth: "Bearer (PAT) on POST /mcp",
      })
    }),

    post("/mcp", guard(async (c) => {
      if (!(await mcpEnabled(db))) {
        return json(c, 503, { error: "MCP is disabled on this instance" })
      }

      const userId = authId(c)
      const user = await loadMcpUserById(db, userId)
      if (!user) {
        return json(c, 401, { error: "Authenticated user no longer exists" })
      }

      const ctx: TangleMcpContext = {
        db,
        store,
        repoDir,
        userId: user.id,
        user,
      }

      // Atlas built-ins (db.query, health.*, migrate.*) plus tangle's
      // domain tools, filtered per request so an owner can flip the
      // category toggles without restarting.
      const cats = await enabledCategories(db)
      const atlasCtx = createContext({ db, migrationsDir: "./migrations" })
      const builtIns = filterByCategory(collectTools(atlasCtx), cats, ATLAS_BUILTIN_CATEGORY)
      const ours = filterByCategory(tangleTools(ctx), cats, "read")
      const server = createMcpServer([...builtIns, ...ours], atlasCtx)

      // Atlas's handleRequest covers initialize / notifications/initialized
      // / tools/list / tools/call. We pre-handle `ping` for MCP-spec
      // compliance since createMcpServer treats it as unknown.
      const body = c.body as { jsonrpc?: string; id?: string | number; method?: string; params?: unknown }
      if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
        return json(c, 400, {
          jsonrpc: "2.0",
          id: body?.id ?? null,
          error: { code: -32600, message: "Invalid JSON-RPC request" },
        })
      }
      if (body.method === "ping") {
        return json(c, 200, { jsonrpc: "2.0", id: body.id ?? 0, result: {} })
      }
      const res = await server.handleRequest({
        jsonrpc: "2.0",
        id: body.id,
        method: body.method,
        params: body.params,
      })
      return json(c, 200, res)
    })),
  ]
}

// Owner-facing preview: returns the catalog of tools split into advertised
// vs hidden by current category gating. Lets the admin UI show exactly what
// an AI client would see without having to mint a PAT and run a JSON-RPC
// client.
export const adminMcpRoutes = (deps: HttpMcpDeps) => {
  const { db, secret, store, repoDir, appUrl } = deps
  const ownerCheck = ownerOnly(db)
  const guard = pipeline(requireAuth({ secret, db }), ownerCheck)
  return [
    get("/admin/mcp/preview", guard(async (c) => {
      const enabled = await mcpEnabled(db)
      const cats = await enabledCategories(db)

      // Use the calling owner's identity to build a representative tool
      // list — tools whose schema is identity-independent will render the
      // same for any user, and ones that aren't are still useful to preview.
      const userId = authId(c)
      const user = await loadMcpUserById(db, userId)
      const ctx: TangleMcpContext = {
        db, store, repoDir,
        userId: user?.id ?? null,
        user,
      }
      const atlasCtx = createContext({ db, migrationsDir: "./migrations" })
      const allBuiltIns = collectTools(atlasCtx)
      const allOurs = tangleTools(ctx)
      const all = [...allBuiltIns, ...allOurs]

      const advertised = all.filter(t => cats.has(CATEGORY[t.name] ?? ATLAS_BUILTIN_CATEGORY))
      const advertisedNames = new Set(advertised.map(t => t.name))

      return json(c, 200, {
        enabled,
        endpoint: `${appUrl.replace(/\/$/, "")}/mcp`,
        advertised_tools: advertised.map(t => ({
          name: t.name,
          category: CATEGORY[t.name] ?? ATLAS_BUILTIN_CATEGORY,
          description: t.description,
        })),
        hidden_tools: all.filter(t => !advertisedNames.has(t.name)).map(t => ({
          name: t.name,
          category: CATEGORY[t.name] ?? ATLAS_BUILTIN_CATEGORY,
        })),
      })
    })),
  ]
}

