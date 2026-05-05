// Cursor pagination. Cursors are opaque base64-encoded JSON so the
// shape can evolve without breaking older clients. Today every cursor
// is just `{id: number}`; tomorrow it could carry a (created_at, id)
// tuple for time-ordered windows.
//
// All list endpoints share the same response envelope:
//   { items: T[], next_cursor: string | null }
// The SPA + MCP server can iterate by passing back `next_cursor`
// until it is null. Non-null but empty `items` never happens — we
// stop emitting `next_cursor` once there are no more rows.

export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 200

export type CursorParams = {
  /** Last id returned on the previous page; null on the first page. */
  beforeId: number | null
  /** Page size capped at MAX_LIMIT. */
  limit: number
}

const decodeCursor = (raw: string | null): number | null => {
  if (!raw) return null
  try {
    const decoded = JSON.parse(atob(raw)) as { id?: unknown }
    if (typeof decoded.id === "number" && Number.isFinite(decoded.id)) return decoded.id
  } catch { /* fallthrough */ }
  return null
}

export const encodeCursor = (id: number): string => btoa(JSON.stringify({ id }))

export const parseCursor = (req: Request): CursorParams => {
  const url = new URL(req.url)
  const limitRaw = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT)
  const limit = Number.isInteger(limitRaw) && limitRaw > 0
    ? Math.min(limitRaw, MAX_LIMIT)
    : DEFAULT_LIMIT
  return {
    beforeId: decodeCursor(url.searchParams.get("cursor")),
    limit,
  }
}

// Helper for the most common shape: id-DESC pagination. The caller
// fetches `limit + 1` rows; if all `limit + 1` came back, the last is
// trimmed and used as the next cursor.
export const paginate = <T extends { id: number }>(
  rows: T[],
  limit: number,
): { items: T[]; next_cursor: string | null } => {
  if (rows.length > limit) {
    const items = rows.slice(0, limit)
    const last = items[items.length - 1]
    return { items, next_cursor: last ? encodeCursor(last.id) : null }
  }
  return { items: rows, next_cursor: null }
}
