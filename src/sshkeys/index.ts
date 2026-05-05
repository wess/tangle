import { createHash } from "node:crypto"
import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { del, get, json, parseJson, pipeline, post } from "@atlas/server"
import { requireAuth } from "../auth/guard.ts"
import { logEvent } from "../security/audit.ts"
import { clientIp, userAgent } from "../security/ratelimit.ts"
import { apiError } from "../util/errors.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

// Validate a one-line OpenSSH public key (`ssh-ed25519 AAAA... [comment]`)
// and compute its SHA256 fingerprint. We accept the four standard key
// types; anything else is rejected at the boundary.
const SUPPORTED_TYPES = new Set([
  "ssh-ed25519",
  "ssh-rsa",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "sk-ssh-ed25519@openssh.com",
])

type ParsedKey = { keyType: string; blob: string; fingerprint: string }

const parsePublicKey = (raw: string): ParsedKey | null => {
  const trimmed = raw.trim()
  const parts = trimmed.split(/\s+/)
  if (parts.length < 2) return null
  const [keyType, blob] = parts
  if (!keyType || !blob || !SUPPORTED_TYPES.has(keyType)) return null
  let bytes: Buffer
  try { bytes = Buffer.from(blob, "base64") } catch { return null }
  if (bytes.length === 0) return null
  // OpenSSH SHA256 fingerprint format: `SHA256:<base64-no-padding>`.
  const digest = createHash("sha256").update(bytes).digest("base64").replace(/=+$/, "")
  return { keyType, blob, fingerprint: `SHA256:${digest}` }
}

export const sshKeyRoutes = (db: Connection, secret: string) => {
  const guard = pipeline(requireAuth({ secret, db }))
  const authed = pipeline(requireAuth({ secret, db }), parseJson)

  return [
    get("/me/ssh-keys", guard(async (c) => {
      const userId = authId(c)
      const rows = await db.all(
        from("ssh_keys")
          .where(q => q("user_id").equals(userId))
          .select("id", "title", "key_type", "fingerprint", "last_used_at", "created_at")
          .orderBy("created_at", "DESC"),
      )
      return json(c, 200, rows)
    })),

    post("/me/ssh-keys", authed(async (c) => {
      const userId = authId(c)
      const body = c.body as { title?: string; key?: string }
      const title = body.title?.trim()
      const key = body.key?.trim()
      if (!title) return apiError(c, "validation", "title required")
      if (!key) return apiError(c, "validation", "key required")

      const parsed = parsePublicKey(key)
      if (!parsed) return apiError(c, "validation", "Unsupported or malformed SSH public key")

      // Fingerprints are unique across all users — a key can only ever
      // identify one account, otherwise SSH multiplexing would let
      // someone push as somebody else.
      const existing = await db.one(
        from("ssh_keys").where(q => q("fingerprint").equals(parsed.fingerprint)).select("id", "user_id"),
      ) as { id: number; user_id: number } | null
      if (existing) {
        return apiError(c, "conflict", existing.user_id === userId
          ? "You already have this key registered"
          : "This key is already registered to another account")
      }

      const inserted = await db.execute(
        from("ssh_keys").insert({
          user_id: userId,
          title,
          key_type: parsed.keyType,
          public_key: `${parsed.keyType} ${parsed.blob}`,
          fingerprint: parsed.fingerprint,
        }).returning("id", "title", "key_type", "fingerprint", "created_at"),
      ) as Array<unknown>
      logEvent(db, {
        userId,
        event: "ssh_key.added",
        metadata: { fingerprint: parsed.fingerprint },
        ip: clientIp(c.request),
        userAgent: userAgent(c.request),
      })
      return json(c, 201, { ...(inserted[0] as object), last_used_at: null })
    })),

    del("/me/ssh-keys/:id", guard(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const row = await db.one(
        from("ssh_keys").where(q => q("id").equals(id)).where(q => q("user_id").equals(userId)).select("id", "fingerprint"),
      ) as { id: number; fingerprint: string } | null
      if (!row) return apiError(c, "not_found", "Key not found")
      await db.execute(from("ssh_keys").where(q => q("id").equals(id)).del())
      logEvent(db, {
        userId,
        event: "ssh_key.removed",
        metadata: { fingerprint: row.fingerprint },
        ip: clientIp(c.request),
        userAgent: userAgent(c.request),
      })
      return json(c, 200, { removed: id })
    })),
  ]
}
