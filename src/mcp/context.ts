import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import type { StorageHandle } from "../storage/index.ts"

// MCP runs locally, alongside the operator's editor. Auth is therefore
// implicit: the server identifies as a specific user (the owner by
// default, or whatever `TANGLE_MCP_USER` selects). All tool handlers
// see this resolved id and use it for permission checks. Setting
// TANGLE_MCP_USER to "anonymous" makes the MCP browse only public
// repos — useful for letting an LLM explore without privileged auth.
export type TangleMcpContext = {
  db: Connection
  store: StorageHandle
  repoDir: string
  /** Resolved user id the MCP runs as. null = anonymous. */
  userId: number | null
  /** Cached user record for the configured identity (null when anon). */
  user: { id: number; username: string; name: string; is_owner: boolean } | null
}

export const resolveMcpUser = async (
  db: Connection,
  override: string | null,
): Promise<TangleMcpContext["user"]> => {
  // Explicit anonymous mode — the operator wants the MCP gated to
  // public-only data.
  if (override === "anonymous") return null

  // If a username/email is supplied, prefer that. We accept either form
  // because operators usually remember one or the other.
  if (override) {
    const isEmail = override.includes("@")
    const row = await db.one(
      from("users")
        .where(q => isEmail ? q("email").equals(override.toLowerCase()) : q("username").equals(override.toLowerCase()))
        .where(q => q("deleted_at").isNull())
        .select("id", "username", "name", "is_owner"),
    ) as { id: number; username: string; name: string; is_owner: boolean } | null
    if (!row) {
      throw new Error(`TANGLE_MCP_USER='${override}' not found in users table`)
    }
    return row
  }

  // Default: the instance owner. Stable identity since first-signup ==
  // owner and the flag never moves.
  const owner = await db.one(
    from("users")
      .where(q => q("is_owner").equals(true))
      .where(q => q("deleted_at").isNull())
      .select("id", "username", "name", "is_owner")
      .limit(1),
  ) as { id: number; username: string; name: string; is_owner: boolean } | null
  return owner
}

// HTTP MCP path: bearer auth has already pinned a user id. Hydrate the
// fields the tool layer expects (`username` for fork/create defaults,
// `is_owner` for the `tangle.users.me` introspection tool).
export const loadMcpUserById = async (
  db: Connection,
  id: number,
): Promise<TangleMcpContext["user"]> => {
  const row = await db.one(
    from("users")
      .where(q => q("id").equals(id))
      .where(q => q("deleted_at").isNull())
      .select("id", "username", "name", "is_owner"),
  ) as { id: number; username: string; name: string; is_owner: boolean } | null
  return row
}
