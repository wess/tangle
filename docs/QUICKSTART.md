# Quickstart

Zero to a public repo with an open issue, in about ten minutes.

## Prerequisites

- **Docker + docker-compose** for the recommended path, or **Bun** + **Postgres 16** + **git** for local development
- A spare hostname or `localhost` for testing

## 1. Get the source

```sh
git clone https://github.com/wess/tangle
cd tangle
cp .env.example .env
```

## 2. Set the basics in `.env`

Edit at minimum:

```sh
SECRET=$(openssl rand -hex 32)        # any strong random string
POSTGRES_PASSWORD=...                  # for the local Postgres container
DOMAIN=localhost                       # or your real hostname
```

Leave `RESEND_API_KEY` empty for now — outgoing email logs to the console while it's blank.

## 3. Boot it

### Docker (recommended)

```sh
docker compose up -d
```

This starts four containers: Postgres, the API, the web SPA, and Caddy. Caddy issues an internal cert for `localhost` (or auto-provisions Let's Encrypt for a real domain).

Open http://localhost or https://your-domain. You should see the signup page.

### Local dev (no Docker)

You'll need Postgres 16 running locally with a `tangle` database, plus the upstream `git` binary on `PATH`.

```sh
createdb tangle
bun install
bun run dev
```

API on :3000, SPA on :3001. Visit http://localhost:3001.

## 4. Create the owner account

The first signup becomes the instance owner — no invite required. Subsequent signups need an invite token (issued by an owner via Settings → Admin → Invites).

Pick a username. Tangle's user/org login namespace is shared, so `tangle.example.com/<your-login>/<repo>` will be your clone URL shape.

## 5. Make a repo

Click **New repository** in the sidebar. Give it a name, choose public or private, hit **Create repo**. Tangle:

1. Inserts the row in `repos`
2. Runs `git init --bare` under `REPO_DIR/<owner>/<repo>.git` on disk

## 6. Generate a personal access token

Settings → Personal access tokens → **Generate**. Pick a scope (`repo` for read+write). The plaintext token is shown **once** — copy it now.

## 7. Push your first commit

```sh
echo "# hello" > README.md
git init
git add README.md
git commit -m "first commit"
git branch -M main
git remote add origin http://USER:tangle_pat_…@localhost:3000/your-login/your-repo.git
git push -u origin main
```

The username field is ignored; the password is the PAT. Once pushed, the Code tab shows the README rendered as markdown.

## 8. Open an issue

From the Issues tab on the repo, **New issue**, type a markdown body, **Open issue**. The body is rendered server-side with sanitize-html — no XSS, no `<script>` shenanigans, full GFM support including tables and task lists.

## 9. (Optional) Wire up the MCP server

If you use an AI assistant that speaks MCP (like Claude Code), point it at:

```json
{
  "tangle": {
    "command": "bun",
    "args": ["src/mcp/serve.ts"],
    "cwd": "/path/to/tangle"
  }
}
```

The assistant can now list your repos, browse code, open PRs, and merge them. See [MCP.md](MCP.md) for the full tool catalog.

## 10. Make it real

Before going live, set in `.env`:

- `NODE_ENV=production` — the API refuses to start with the default `SECRET` otherwise
- `RESEND_API_KEY=...` — outgoing email actually goes out
- `RP_ID=your-domain` and `RP_ORIGIN=https://your-domain` — passkeys are pinned to the RP, so test these match what users see in their browser
- `TRUSTED_PROXIES=172.16.0.0/12` — when behind Caddy/k8s/nginx, so X-Forwarded-For is honored

Then `docker compose up -d --build`. You're shipped.

---

Stuck? Check [TROUBLESHOOTING.md](TROUBLESHOOTING.md) or open an issue.
