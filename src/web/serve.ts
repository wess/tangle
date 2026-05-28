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

// SPA fallback policy: any path that isn't /api, an existing built asset,
// a git smart-HTTP request (/<owner>/<repo>.git/…, which the api serves),
// or an asset-shaped path returns index.html so React Router takes over
// client-side. We don't keep an allowlist of routes — Tangle has many
// (/me, /settings, /:owner/:repo, /:owner/:repo/issues, …) and an
// out-of-date list here surfaces as a 404 "Not Found" body which, on
// top-level Safari navigations, manifests as a download prompt.

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

// Bun.build emits `<script type="module" crossorigin src="…">` and the
// matching crossorigin on <link rel="stylesheet">. The assets are same-
// origin, so the attribute is gratuitous — Safari fetches them in CORS
// mode, finds no Access-Control-Allow-Origin on the response, refuses to
// execute the module, and falls back to a "do you want to download this"
// prompt for the bundle file. Strip the attribute so Safari treats them
// as ordinary same-origin loads.
const indexHtml = (await Bun.file(join(DIST, "index.html")).text()).replace(
  / crossorigin(?=[\s>])/g,
  "",
)

const serveAsset = async (path: string): Promise<Response | null> => {
  const safe = path.replace(/^\/+/, "")
  if (safe.includes("..")) return null
  const file = Bun.file(join(DIST, safe))
  if (!(await file.exists())) return null
  return new Response(file)
}

// Heuristic: a request is for an asset file (not a SPA navigation) when
// its last path segment contains a dot — `/foo/bar.png`, `/manifest.json`,
// `/favicon.ico`, etc. SPA routes never have an extension on the final
// segment.
const looksLikeAsset = (path: string): boolean => {
  const last = path.split("/").pop() ?? ""
  return last.includes(".")
}

// Git smart-HTTP lives at /<owner>/<repo>.git/info/refs etc. and is
// fronted by the api container at port 3000 — nginx already routes those
// paths there, so we never see them here in normal operation. Belt-and-
// braces: if one slips through, treat it as not-a-SPA so it doesn't get
// the index.html.
const isGitSmartHttp = (path: string): boolean =>
  path.split("/").some((s) => s.endsWith(".git"))

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

    const asset = await serveAsset(url.pathname)
    if (asset) return asset

    if (looksLikeAsset(url.pathname) || isGitSmartHttp(url.pathname)) {
      return new Response("Not Found", { status: 404 })
    }

    return new Response(indexHtml, {
      headers: { "content-type": "text/html;charset=utf-8" },
    })
  },
})

console.log(`[tangle] web on http://localhost:${PORT}`)
