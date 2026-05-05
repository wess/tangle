import index from "./index.html"

const API = process.env.API_URL ?? "http://localhost:3000"
const PORT = Number(process.env.WEB_PORT ?? 3001)

// Dev-only: HMR + verbose console in the browser. In production this
// MUST be false, otherwise Bun bundles the SPA with the dev JSX runtime
// (jsxDEV) but resolves React to the prod runtime that has no jsxDEV
// export — every component crashes at first render.
const isDev = (process.env.NODE_ENV ?? "development") === "development"

// Proxy `/api/*` straight through to the API process. Strip the `/api`
// prefix so the SPA-side path map cleanly mirrors the API's endpoints.
// Caught and 502'd if the API process is unreachable so the SPA's
// fetch sees a structured error instead of a network exception.
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
  // CRITICAL: `/api/*` MUST be listed first. Bun matches routes in
  // declaration order, and the dynamic `/:owner/:name` pattern below is
  // greedy enough to swallow `/api/setup` (`:owner=api`, `:name=setup`),
  // which would static-serve the SPA HTML on GET and 405 on POST.
  routes: {
    "/api/*": proxy,
    "/": index,
    "/login": index,
    "/signup": index,
    "/explore": index,
    "/new": index,
    "/settings": index,
    "/settings/:section": index,
    "/app/*": index,
    "/u/:username": index,
    "/orgs/:login": index,
    // Repo pages: /:owner/:name and any subpath (issues, pulls, etc.)
    "/:owner/:name": index,
    "/:owner/:name/*": index,
  },
  fetch() {
    return new Response("Not Found", { status: 404 })
  },
  development: isDev ? { hmr: true, console: true } : false,
})

console.log(`[tangle] web on http://localhost:${PORT}`)
