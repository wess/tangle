# Tangle

**A delightful, self-hosted git server for your home lab.**

GitHub-style code hosting that fits in `docker compose up` — issues, pull requests, releases, webhooks, an MCP server for your AI assistant, and a sidebar that doesn't look like it was thrown together in 2009.

```sh
git clone https://github.com/wess/tangle && cd tangle
cp .env.example .env
docker compose up -d
open http://localhost
```

The first signup becomes the owner. You're done.

---

## Why Tangle?

You've got a NAS, a Synology, a beefy Mac mini under the stairs, or a 1U in the basement. You want your code there, not on someone else's server. Existing options either feel like enterprise software ported reluctantly to home use or eat 4 GB of RAM at idle. Tangle is small, fast, and *pleasant*.

- **Two processes**, one Postgres, that's it
- **Bare git repos on disk** — your data, in standard format, recoverable with plain `git`
- **MIT licensed**, no CLA, no telemetry, no marketing emails
- **Built on [Atlas](https://github.com/wess/atlas)** — designed to compose with sibling apps in the same suite

---

## Quickstart

### Docker compose (recommended)

```sh
cp .env.example .env
# Set DOMAIN (or :80 for HTTP), POSTGRES_PASSWORD, SECRET, RESEND_API_KEY.
docker compose up -d
```

Caddy serves on `:80` and `:443` with automatic Let's Encrypt when `DOMAIN` is a real hostname.

### Local development

```sh
bun install
bun run dev    # API on :3000, web on :3001
```

Need just one process?

```sh
bun run api
bun run web
bun run mcp     # MCP server for AI assistants
```

Visit **http://localhost:3001/signup** — your account becomes the owner.

### Clone your first repo

After creating a repo through the web UI:

```sh
git clone http://localhost:3000/<owner>/<repo>.git
```

When git asks for credentials, use any username and a personal access token (Settings → Personal access tokens) as the password.

---

## What's inside

| | |
|---|---|
| **Repositories** | HTTP Smart-Protocol clone/push, per-repo collaborators (reader/writer/admin), forks, archive, default-branch override |
| **Code browsing** | File tree, blob viewer, commit log, README rendering, ref switcher |
| **Issues & PRs** | Shared numbering, markdown bodies, comments, fast-forward merge, color-coded diff viewer |
| **Releases** | Tagged releases with attached download assets served from S3 or local disk |
| **Stars** | Like good ol' GitHub |
| **Webhooks** | Push, issues, pull_request, release, star — HMAC-SHA256 signed, delivery log per repo |
| **External mirrors** | Configure an upstream URL and Tangle pulls from it on a 15-minute schedule |
| **Auth** | Email + password, TOTP 2FA, full session list, invite-only signup after the first user |
| **SSH keys & PATs** | Register OpenSSH keys; scoped personal access tokens (`repo`, `repo:read`, `repo:write`, `admin`) for git CLI |
| **MCP server** | 32 domain tools your AI assistant can call to drive Tangle — list repos, browse code, open PRs, merge them |
| **Theme** | Light + dark, Nord palette throughout |

---

## Architecture in one paragraph

Two long-lived Bun processes: the **API** (`bun src/server.ts`, port 3000) handles JSON, the git Smart-HTTP wire protocol, and attachment uploads; the **web** server (`bun src/web/serve.ts`, port 3001) serves the SPA and proxies `/api/*` to the API. In production, Caddy fronts both — `*.git/*` paths route straight to the API, everything else through the web container. Bare repositories live under `REPO_DIR` on disk; user-uploaded blobs (avatars, release assets) live in a pluggable storage backend (S3 or local). Postgres is the system of record for everything else.

Full notes: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Documentation

- **[Quickstart](docs/QUICKSTART.md)** — from zero to first push, walked through
- **[Common workflows](docs/USAGE.md)** — opening PRs, mirroring upstream, running the MCP, etc.
- **[Architecture](docs/ARCHITECTURE.md)** — data model, request pipeline, where bytes live
- **[API reference](docs/API.md)** — every JSON endpoint
- **[MCP server](docs/MCP.md)** — wire it into Claude Code or any MCP-aware host
- **[Configuration](docs/CONFIGURATION.md)** — every env var
- **[Deploy](docs/DEPLOY.md)** — going to production
- **[Contributing](docs/CONTRIBUTING.md)** — how to file issues and PRs against Tangle itself

---

## License

MIT — see [LICENSE](LICENSE). Use it however you like.

---

## Acknowledgements

Built on [**Atlas**](https://github.com/wess/atlas) — composable Bun/TypeScript building blocks. If you like Tangle's shape, check out its sibling apps in the same suite.
