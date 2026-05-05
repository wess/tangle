import type { Connection } from "@atlas/db"

export type RateLimitResult = {
  ok: boolean
  count: number
  retryAfterSeconds: number
}

export const checkRate = async (
  db: Connection,
  bucket: string,
  max: number,
  windowSeconds: number,
): Promise<RateLimitResult> => {
  // Atomic UPSERT: insert with count=1 OR update by either resetting (window
  // expired) or incrementing. Returns the resulting count + window start so
  // we can compute retry-after for blocked callers.
  const text = `
    INSERT INTO rate_limits (bucket, count, window_started_at)
    VALUES ($1, 1, NOW())
    ON CONFLICT (bucket) DO UPDATE SET
      count = CASE
        WHEN rate_limits.window_started_at < NOW() - ($2 || ' seconds')::interval THEN 1
        ELSE rate_limits.count + 1
      END,
      window_started_at = CASE
        WHEN rate_limits.window_started_at < NOW() - ($2 || ' seconds')::interval THEN NOW()
        ELSE rate_limits.window_started_at
      END
    RETURNING count, EXTRACT(EPOCH FROM window_started_at)::bigint AS started
  `
  const rows = await db.execute({ text, values: [bucket, String(windowSeconds)] }) as Array<{
    count: number
    started: number | string | bigint
  }>
  const row = rows[0]
  const count = Number(row?.count ?? 0)
  if (count <= max) {
    return { ok: true, count, retryAfterSeconds: 0 }
  }
  // EXTRACT(EPOCH FROM ...)::bigint rounds rather than floors, so the
  // returned start can be a tick ahead of Date.now()/1000. Clamp.
  const startedSec = Number(row?.started ?? 0)
  const elapsed = Math.max(0, Math.floor(Date.now() / 1000) - startedSec)
  const retryAfter = Math.min(windowSeconds, Math.max(1, windowSeconds - elapsed))
  return { ok: false, count, retryAfterSeconds: retryAfter }
}

type Cidr = { addr: number; mask: number; bits: number }
const ipv4ToInt = (ip: string): number | null => {
  const parts = ip.split(".")
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    const v = Number(p)
    if (!Number.isInteger(v) || v < 0 || v > 255) return null
    n = (n * 256) + v
  }
  return n >>> 0
}
const parseCidr = (raw: string): Cidr | null => {
  const [ip, prefix] = raw.includes("/") ? raw.split("/") : [raw, "32"]
  const bits = Number(prefix)
  if (!ip || !Number.isInteger(bits) || bits < 0 || bits > 32) return null
  const addr = ipv4ToInt(ip)
  if (addr === null) return null
  const mask = bits === 0 ? 0 : (~((1 << (32 - bits)) - 1)) >>> 0
  return { addr: (addr & mask) >>> 0, mask, bits }
}
const TRUSTED_PROXIES: Cidr[] = (process.env.TRUSTED_PROXIES ?? "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean)
  .map(parseCidr)
  .filter((c): c is Cidr => c !== null)

const ipInTrusted = (ip: string): boolean => {
  if (TRUSTED_PROXIES.length === 0) return false
  const n = ipv4ToInt(ip)
  if (n === null) return false
  return TRUSTED_PROXIES.some(c => ((n & c.mask) >>> 0) === c.addr)
}

const peerIp = (req: Request): string =>
  (req as { peerIp?: string }).peerIp ?? "unknown"

export const clientIp = (req: Request): string => {
  const peer = peerIp(req)
  if (ipInTrusted(peer)) {
    const fwd = req.headers.get("x-forwarded-for")
    if (fwd) {
      const first = fwd.split(",")[0]?.trim()
      if (first) return first
    }
    const real = req.headers.get("x-real-ip")
    if (real) return real
  }
  return peer
}

export const userAgent = (req: Request): string =>
  (req.headers.get("user-agent") ?? "").slice(0, 256)
