import { json } from "@atlas/server"
import type { Conn } from "@atlas/server"

// Stable, machine-readable error codes. Adding a new one is fine; do
// not rename or repurpose an existing one — clients (the SPA, the MCP
// server, future SDKs) branch on these strings.
export type ErrorCode =
  | "not_found"
  | "forbidden"
  | "unauthorized"
  | "validation"
  | "conflict"
  | "rate_limited"
  | "too_large"
  | "not_ancestor"
  | "missing_ref"
  | "ref_update_failed"
  | "internal"

const STATUS_FOR: Record<ErrorCode, number> = {
  not_found: 404,
  forbidden: 403,
  unauthorized: 401,
  validation: 422,
  conflict: 409,
  rate_limited: 429,
  too_large: 413,
  not_ancestor: 409,
  missing_ref: 409,
  ref_update_failed: 409,
  internal: 500,
}

export type ApiError = {
  error: string
  code: ErrorCode
  // Free-form bag for anything code-specific (retry_after, detail, etc.)
  // We keep it on the same envelope rather than nesting under `data` so
  // tooling that already reads `retry_after` keeps working.
  [k: string]: unknown
}

// Build an ApiError envelope and write it to the conn. The caller can
// pass extra fields for code-specific data (retry_after, detail, …).
export const apiError = (
  c: Conn,
  code: ErrorCode,
  message: string,
  extra: Record<string, unknown> = {},
): Conn => {
  const status = STATUS_FOR[code]
  return json(c, status, { error: message, code, ...extra })
}

// Convenience wrappers for the three most-common error paths.
export const notFound = (c: Conn, what = "Not found") => apiError(c, "not_found", what)
export const forbidden = (c: Conn, why = "Forbidden") => apiError(c, "forbidden", why)
export const validation = (c: Conn, message: string) => apiError(c, "validation", message)
