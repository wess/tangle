import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import type { Conn } from "@atlas/server"
import { get, halt, json, parseJson, patch, pipeline } from "@atlas/server"
import { requireAuth } from "../auth/guard.ts"
import { ownerOnly } from "../security/owner.ts"

// Owner-controlled feature toggles. Stored as JSON-encoded strings so the
// same table can hold booleans, ints, or small objects. Routes that gate on
// a setting do so at request time (not at boot) so the owner can flip
// toggles in the admin UI without restarting the API.

export const SETTING_MCP_ENABLED = "mcp_enabled"
export const SETTING_MCP_TOOL_READ = "mcp_tool_read"
export const SETTING_MCP_TOOL_WRITE = "mcp_tool_write"
export const SETTING_MCP_TOOL_DELETE = "mcp_tool_delete"

// The full set of toggleable keys + their default value. New settings get
// added here; the admin endpoints reject any key not in this map so the
// table doesn't become a free-form dumping ground.
const REGISTRY = {
  [SETTING_MCP_ENABLED]: { default: false, type: "boolean" as const, description: "Model Context Protocol server at /mcp. When off the endpoint returns 503 regardless of per-tool toggles. AI clients (Claude Desktop, IDEs) authenticate with a PAT." },
  [SETTING_MCP_TOOL_READ]: { default: true, type: "boolean" as const, description: "Expose read-only MCP tools: list repos, browse trees/blobs, read issues/PRs, fetch commit history. Safe default — these only return data the caller's token already has access to." },
  [SETTING_MCP_TOOL_WRITE]: { default: false, type: "boolean" as const, description: "Expose write MCP tools: create repos/issues/PRs, comment, merge, set mirrors, create labels. Off by default — opt in once you trust the AI client." },
  [SETTING_MCP_TOOL_DELETE]: { default: false, type: "boolean" as const, description: "Expose destructive MCP tools: delete repos. There is no soft-delete recovery for repos — turn this on only if you're certain." },
}

type SettingKey = keyof typeof REGISTRY

export const isKnownSetting = (key: string): key is SettingKey => key in REGISTRY

export const getBoolean = async (db: Connection, key: SettingKey): Promise<boolean> => {
  if (REGISTRY[key].type !== "boolean") throw new Error(`Setting ${key} is not a boolean`)
  const row = await db.one(
    from("instance_settings").where(q => q("key").equals(key)).select("value"),
  ) as { value: string } | null
  if (!row) return REGISTRY[key].default as boolean
  try { return JSON.parse(row.value) === true } catch { return REGISTRY[key].default as boolean }
}

const setRaw = async (db: Connection, key: SettingKey, value: unknown, updatedBy: number | null): Promise<void> => {
  const encoded = JSON.stringify(value)
  await db.execute({
    text: `INSERT INTO instance_settings (key, value, updated_by) VALUES ($1, $2, $3)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    values: [key, encoded, updatedBy],
  })
}

const authId = (c: any) => (c.assigns.auth as { id: number }).id

// Pipeline guard that 503s when a feature is disabled. Cheap — one indexed
// PK lookup per request.
export const requireSettingEnabled = (db: Connection, key: SettingKey) => async (conn: Conn): Promise<Conn> => {
  const enabled = await getBoolean(db, key)
  if (!enabled) {
    return halt(conn, 503, { error: `${key} is disabled on this instance. Ask the owner to enable it in Admin → Settings.` })
  }
  return conn
}

export const adminSettingsRoutes = (db: Connection, secret: string) => {
  const ownerCheck = ownerOnly(db)
  const guard = pipeline(requireAuth({ secret, db }), ownerCheck)
  const authed = pipeline(requireAuth({ secret, db }), ownerCheck, parseJson)

  return [
    get("/admin/settings", guard(async (c) => {
      const rows = await db.all(
        from("instance_settings").select("key", "value", "updated_by", "updated_at"),
      ) as Array<{ key: string; value: string; updated_by: number | null; updated_at: string }>
      const byKey = new Map(rows.map(r => [r.key, r]))

      const settings = Object.entries(REGISTRY).map(([key, meta]) => {
        const row = byKey.get(key)
        let parsed: unknown = meta.default
        if (row) { try { parsed = JSON.parse(row.value) } catch { parsed = meta.default } }
        return {
          key,
          value: parsed,
          type: meta.type,
          description: meta.description,
          default: meta.default,
          updated_by: row?.updated_by ?? null,
          updated_at: row?.updated_at ?? null,
        }
      })
      return json(c, 200, settings)
    })),

    patch("/admin/settings", authed(async (c) => {
      const userId = authId(c)
      const body = c.body as Record<string, unknown>
      const updates: Array<{ key: SettingKey; value: unknown }> = []
      for (const [key, value] of Object.entries(body)) {
        if (!isKnownSetting(key)) return json(c, 422, { error: `Unknown setting key: ${key}` })
        const meta = REGISTRY[key]
        if (meta.type === "boolean" && typeof value !== "boolean") {
          return json(c, 422, { error: `${key} must be a boolean` })
        }
        updates.push({ key, value })
      }
      if (updates.length === 0) return json(c, 422, { error: "Nothing to update" })
      for (const u of updates) await setRaw(db, u.key, u.value, userId)
      return json(c, 200, { updated: updates.map(u => u.key) })
    })),
  ]
}

// Convenience read helpers used by other modules' route gates.
export const mcpEnabled = (db: Connection) => getBoolean(db, SETTING_MCP_ENABLED)
export const mcpToolEnabled = (db: Connection, category: "read" | "write" | "delete") => {
  const key = category === "read" ? SETTING_MCP_TOOL_READ
    : category === "write" ? SETTING_MCP_TOOL_WRITE
    : SETTING_MCP_TOOL_DELETE
  return getBoolean(db, key)
}
