// Strict default headers. CSP is strict-by-default for production;
// development allows the Bun HMR websocket and inline runtime that
// `bun build` injects. Toggle via NODE_ENV.
const isDev = (process.env.NODE_ENV ?? "development") === "development"

const CSP_PROD =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob: https:; " +
  "font-src 'self' data:; " +
  "connect-src 'self'; " +
  "media-src 'self' blob:; " +
  "object-src 'none'; " +
  "base-uri 'self'; " +
  "form-action 'self'; " +
  "frame-ancestors 'none'"

const CSP_DEV =
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-eval' 'unsafe-inline'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob: https:; " +
  "font-src 'self' data:; " +
  "connect-src 'self' ws: wss: http: https:; " +
  "media-src 'self' blob:; " +
  "object-src 'none'; " +
  "base-uri 'self'; " +
  "form-action 'self'; " +
  "frame-ancestors 'none'"

const HEADERS: Record<string, string> = {
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-site",
  "content-security-policy": isDev ? CSP_DEV : CSP_PROD,
}

// Bun.serve passes a `server` argument that exposes the raw socket peer
// via `server.requestIP(req)`. We stash that onto the request so
// downstream code (rate-limit buckets, audit logs) can read the *real*
// peer rather than trusting whatever a client puts in X-Forwarded-For.
type BunServer = { requestIP?: (req: Request) => { address: string } | null }

// `git` shells out to itself when speaking Smart-HTTP — content-types
// are protocol-defined (application/x-git-upload-pack-result, etc.) and
// MUST not be sniffed. Headers are still applied for safety, but the
// strict policies below would break browsers loading raw blob bytes;
// the git wire protocol doesn't render in a browser, so this is moot.
export const withSecurityHeaders = (
  fetch: (req: Request) => Response | Promise<Response>,
): ((req: Request, server?: BunServer) => Promise<Response>) =>
  async (req, server) => {
    if (server?.requestIP) {
      const peer = server.requestIP(req)
      if (peer?.address) {
        ;(req as { peerIp?: string }).peerIp = peer.address
      }
    }
    const res = await fetch(req)
    for (const [k, v] of Object.entries(HEADERS)) {
      if (!res.headers.has(k)) res.headers.set(k, v)
    }
    return res
  }
