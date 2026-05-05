// Tangle logins (users + orgs share the namespace) follow the same shape
// as GitHub: lowercase ASCII, digits, and hyphens. We disallow hyphens at
// the boundaries so a login can never be confused with a CLI flag.
const LOGIN_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/

export const normalizeLogin = (raw: string) => raw.trim().toLowerCase()

export const isValidLogin = (raw: string) => LOGIN_RE.test(raw)

export const isEmail = (raw: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)

// Reserved names the user namespace can never claim — they collide with
// route prefixes or with planned future paths.
const RESERVED = new Set([
  "api", "app", "admin", "assets", "auth", "explore", "favicon.ico",
  "help", "issues", "login", "logout", "marketplace", "new", "notifications",
  "oauth", "orgs", "p", "password", "pulls", "search", "settings", "signup",
  "static", "stars", "topics", "trending", "u", "users", "webhooks",
])

export const isReservedLogin = (raw: string) => RESERVED.has(raw)
