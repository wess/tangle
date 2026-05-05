import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { del, get, json, parseJson, pipeline, post } from "@atlas/server"
import { randomBytes } from "node:crypto"
import { APP_TOKEN_PREFIX, hashToken, requireAuth } from "../auth/guard.ts"
import { apiError } from "../util/errors.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

const generateAppToken = (): string => {
  const raw = randomBytes(32).toString("base64url")
  return `${APP_TOKEN_PREFIX}${raw}`
}

const VALID_SCOPES = new Set(["repo", "repo:read", "repo:write", "admin"])

const validateScopes = (input: string | undefined): string => {
  if (!input || !input.trim()) return "repo"
  const tokens = input.split(/\s+/).filter(Boolean)
  for (const t of tokens) {
    if (!VALID_SCOPES.has(t)) throw new Error(`Unknown scope: ${t}`)
  }
  return tokens.join(" ")
}

export const appRoutes = (db: Connection, secret: string) => {
  // PATs are never created or revoked using *another* PAT — that would
  // be a privilege-escalation footgun. Force JWT-only here by checking
  // the auth `via` channel below.
  const guard = pipeline(requireAuth({ secret, db }))
  const authed = pipeline(requireAuth({ secret, db }), parseJson)

  const requireBrowserAuth = (c: any): { ok: boolean; error?: string } => {
    const via = (c.assigns.auth as { via?: string }).via
    if (via === "app") return { ok: false, error: "PATs cannot manage other PATs — sign in via the web UI" }
    return { ok: true }
  }

  return [
    get("/me/apps", guard(async (c) => {
      const userId = authId(c)
      const rows = await db.all(
        from("apps")
          .where(q => q("user_id").equals(userId))
          .select("id", "name", "description", "token_prefix", "scopes", "last_used_at", "created_at")
          .orderBy("created_at", "DESC"),
      )
      return json(c, 200, rows)
    })),

    post("/me/apps", authed(async (c) => {
      const gate = requireBrowserAuth(c)
      if (!gate.ok) return apiError(c, "forbidden", gate.error ?? "Forbidden")

      const userId = authId(c)
      const body = c.body as { name?: string; description?: string; scopes?: string }
      const name = body.name?.trim()
      const description = body.description?.trim() || null
      if (!name) return apiError(c, "validation", "name required")
      let scopes: string
      try { scopes = validateScopes(body.scopes) } catch (err) { return apiError(c, "validation", (err as Error).message) }

      const fullToken = generateAppToken()
      const tokenHash = hashToken(fullToken)
      const tokenPrefix = fullToken.slice(0, APP_TOKEN_PREFIX.length + 6)

      const inserted = await db.execute(
        from("apps")
          .insert({
            user_id: userId,
            name,
            description,
            token_hash: tokenHash,
            token_prefix: tokenPrefix,
            scopes,
          })
          .returning("id", "name", "description", "token_prefix", "scopes", "created_at"),
      ) as Array<{ id: number; name: string; description: string | null; token_prefix: string; scopes: string; created_at: string }>

      return json(c, 201, {
        ...inserted[0],
        token: fullToken,
        last_used_at: null,
      })
    })),

    del("/me/apps/:id", guard(async (c) => {
      const gate = requireBrowserAuth(c)
      if (!gate.ok) return apiError(c, "forbidden", gate.error ?? "Forbidden")

      const userId = authId(c)
      const id = Number(c.params.id)
      const row = await db.one(
        from("apps")
          .where(q => q("id").equals(id))
          .where(q => q("user_id").equals(userId))
          .select("id"),
      ) as { id: number } | null
      if (!row) return apiError(c, "not_found", "App not found")
      await db.execute(from("apps").where(q => q("id").equals(id)).del())
      return json(c, 200, { revoked: id })
    })),
  ]
}
