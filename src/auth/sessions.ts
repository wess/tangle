import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { del, get, json, pipeline } from "@atlas/server"
import { requireAuth } from "./guard.ts"
import { revokeSession } from "../security/sessions.ts"
import { apiError } from "../util/errors.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id
const authJti = (c: any): string | null => (c.assigns.auth as { jti?: string | null }).jti ?? null

export const sessionRoutes = (db: Connection, secret: string) => {
  const guard = pipeline(requireAuth({ secret, db }))

  return [
    get("/me/sessions", guard(async (c) => {
      const userId = authId(c)
      const currentJti = authJti(c)
      const rows = await db.all(
        from("sessions")
          .where(q => q("user_id").equals(userId))
          .where(q => q("revoked_at").isNull())
          .select("id", "ip", "user_agent", "last_used_at", "created_at", "expires_at")
          .orderBy("last_used_at", "DESC"),
      ) as Array<{ id: string; ip: string | null; user_agent: string | null; last_used_at: string; created_at: string; expires_at: string }>
      return json(c, 200, rows.map(r => ({ ...r, is_current: r.id === currentJti })))
    })),

    del("/me/sessions/:id", guard(async (c) => {
      const userId = authId(c)
      const ok = await revokeSession(db, c.params.id, userId)
      if (!ok) return apiError(c, "not_found", "Session not found")
      return json(c, 200, { revoked: c.params.id })
    })),
  ]
}
