import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { del, get, json, parseJson, pipeline, post } from "@atlas/server"
import { requireAuth } from "../auth/guard.ts"
import { randomToken, sha256Hex } from "../util/token.ts"
import { isEmail } from "../util/username.ts"
import { apiError } from "../util/errors.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id
const authIsOwner = (c: any) => Boolean((c.assigns.auth as { is_owner?: boolean }).is_owner)

export const inviteRoutes = (db: Connection, secret: string) => {
  const guard = pipeline(requireAuth({ secret, db }))
  const authed = pipeline(requireAuth({ secret, db }), parseJson)

  return [
    get("/admin/invites", guard(async (c) => {
      if (!authIsOwner(c)) return apiError(c, "forbidden", "Owner only")
      const rows = await db.all(
        from("invites")
          .select("id", "email", "invited_by", "used_at", "used_by", "created_at")
          .orderBy("created_at", "DESC")
          .limit(200),
      )
      return json(c, 200, rows)
    })),

    post("/admin/invites", authed(async (c) => {
      if (!authIsOwner(c)) return apiError(c, "forbidden", "Owner only")
      const userId = authId(c)
      const body = c.body as { email?: string }
      const email = body.email?.trim().toLowerCase() || null
      if (email && !isEmail(email)) return apiError(c, "validation", "Invalid email")

      const token = randomToken(24)
      const inserted = await db.execute(
        from("invites").insert({
          token_hash: sha256Hex(token),
          email,
          invited_by: userId,
        }).returning("id", "email", "created_at"),
      ) as Array<{ id: number; email: string | null; created_at: string }>
      // The plaintext token is returned ONCE — the owner copies the
      // signup URL and emails it manually. We store only the hash so a
      // DB dump can't replay invites.
      return json(c, 201, { ...inserted[0], token })
    })),

    del("/admin/invites/:id", guard(async (c) => {
      if (!authIsOwner(c)) return apiError(c, "forbidden", "Owner only")
      const id = Number(c.params.id)
      const removed = await db.execute(
        from("invites").where(q => q("id").equals(id)).del().returning("id"),
      ) as Array<{ id: number }>
      if (removed.length === 0) return apiError(c, "not_found", "Invite not found")
      return json(c, 200, { revoked: id })
    })),
  ]
}
