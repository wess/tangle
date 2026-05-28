import { existsSync, mkdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

const API = process.env.API_URL ?? "http://localhost:3000"
const PORT = Number(process.env.WEB_PORT ?? 3001)

// Dev-only: HMR + verbose console in the browser. In production this
// MUST be false, otherwise Bun bundles the SPA with the dev JSX runtime
// (jsxDEV) but resolves React to the prod runtime that has no jsxDEV
// export — every component crashes at first render.
const isDev = (process.env.NODE_ENV ?? "development") === "development"

const HERE = dirname(new URL(import.meta.url).pathname)
const DIST = resolve(HERE, "dist")

// SPA paths — exact matches return index.html so React Router takes over
// client-side. Anything not matching one of these, the dynamic prefixes
// below, the /api proxy, or a built asset → 404. Order matters only for
// readability; the runtime does an exact lookup first.
const SPA_EXACT = new Set([
  "/",
  "/login",
  "/signup",
  "/explore",
  "/new",
  "/settings",
])
const SPA_PREFIXES = ["/settings/", "/app/", "/u/", "/orgs/"]

const buildSpa = async (): Promise<void> => {
  if (!existsSync(DIST)) mkdirSync(DIST, { recursive: true })
  const out = await Bun.build({
    entrypoints: [join(HERE, "index.html")],
    outdir: DIST,
    target: "browser",
    minify: !isDev,
    sourcemap: isDev ? "inline" : "none",
  })
  if (!out.success) {
    for (const log of out.logs) console.error(log)
    throw new Error("SPA bundle failed")
  }
}

await buildSpa()

const indexHtml = await Bun.file(join(DIST, "index.html")).text()

// Repos live at /:owner/:name and /:owner/:name/<anything>. We don't want
// to send index.html for asset paths or for the API, so this matcher only
// fires when the path has exactly 2 segments OR more, AND the first
// segment isn't reserved.
const RESERVED_FIRST_SEGMENT = new Set([
  "api",
  "auth",
  "oauth",
  ".well-known",
  "webdav",
])

const isSpaPath = (path: string): boolean => {
  if (SPA_EXACT.has(path)) return true
  if (SPA_PREFIXES.some((p) => path.startsWith(p))) return true
  // Repo pages: /<owner>/<name>(/<...>)
  const segs = path.split("/").filter(Boolean)
  if (segs.length < 2) return false
  if (RESERVED_FIRST_SEGMENT.has(segs[0]!)) return false
  // Git smart-HTTP (e.g. /<owner>/<repo>.git/info/refs) is fronted by the
  // API, not the SPA — never claim it here.
  if (segs.some((s) => s.endsWith(".git"))) return false
  // Bundle assets land at the root with hashed names (e.g. /chunk-xxx.js)
  // and have exactly 1 segment, so they don't match.
  return true
}

const serveAsset = async (path: string): Promise<Response | null> => {
  const safe = path.replace(/^\/+/, "")
  if (safe.includes("..")) return null
  const file = Bun.file(join(DIST, safe))
  if (!(await file.exists())) return null
  return new Response(file)
}

const proxy = async (req: Request): Promise<Response> => {
  const url = new URL(req.url)
  const target = `${API}${url.pathname.replace("/api", "")}${url.search}`
  try {
    const res = await fetch(target, {
      method: req.method,
      headers: req.headers,
      body: req.body,
    })
    return new Response(res.body, { status: res.status, headers: res.headers })
  } catch (err) {
    console.error(`[tangle web] proxy to ${target} failed:`, err)
    return new Response(
      JSON.stringify({ error: "API unreachable", target }),
      { status: 502, headers: { "content-type": "application/json" } },
    )
  }
}

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  maxRequestBodySize: Number.MAX_SAFE_INTEGER,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url)

    if (url.pathname.startsWith("/api/")) return proxy(req)

    if (isSpaPath(url.pathname)) {
      return new Response(indexHtml, {
        headers: { "content-type": "text/html;charset=utf-8" },
      })
    }

    const asset = await serveAsset(url.pathname)
    if (asset) return asset

    return new Response("Not Found", { status: 404 })
  },
})

console.log(`[tangle] web on http://localhost:${PORT}`)
