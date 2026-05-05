# Troubleshooting

Common things that go wrong, with the fix.

## "An invite token is required for new accounts" on a fresh install

The SPA shows this when `GET /api/setup` returns `needsSetup: false` — i.e., a user already exists. If you didn't create one, it's most likely the API process couldn't reach Postgres on first load and the SPA's catch defaulted (older builds did this).

Fix: confirm `bun run dev` is actually running, and `curl http://localhost:3001/api/setup` returns `{"needsSetup":true}` on a clean DB.

To start over, truncate the users table:

```sh
docker exec -i postgres-dev psql -U postgres -d tangle -c \
  "TRUNCATE users, sessions, audit_events, rate_limits, invites, apps, password_resets, orgs, org_members, ssh_keys, repos, repo_collaborators, issues, pulls, comments, stars, releases, release_assets, webhooks, webhook_deliveries, webauthn_credentials, webauthn_challenges, labels, label_assignments RESTART IDENTITY CASCADE"
rm -rf .tangle/repos/*
```

Then refresh the signup page.

## `git push` fails with "Authentication required"

Push requires a PAT with `repo` or `repo:write` scope. A `repo:read` token won't authenticate.

```sh
# Inspect your token's scope at /settings/tokens.
# If it's read-only, generate a new one with `repo` scope and update your remote URL:
git remote set-url origin "http://USER:tangle_pat_NEW@host:3000/owner/repo.git"
```

## Push of a large repo dies with a 413

Bun buffers the request body; the API caps it at `MAX_UPLOAD_BYTES` (default 1 GiB). Bump it in `.env`:

```sh
MAX_UPLOAD_BYTES=5368709120   # 5 GiB
```

…and restart. Note this is a per-concurrent-push memory ceiling, so set a value your host actually has free.

## Mirror fetch errors

The error is on the repo row in `mirror_last_error`. Common causes:

- **`Authentication failed`** — the upstream is private. Tangle's mirror fetches use the `tangle-mirror` remote with the URL as-is, so embed creds in the URL: `https://user:token@github.com/foo/bar.git`.
- **`Could not resolve host`** — DNS / firewall. Make sure the API container can reach the upstream.
- **`shallow update not allowed`** — you tried to mirror from a shallow clone source. Mirror only works against full repos.

Force a re-sync by setting `mirror_url` to the same value again — the `POST /repos/.../mirror` endpoint always triggers an immediate fetch.

## Caddy says certs aren't issuing

For real domains:
- DNS A/AAAA records for `DOMAIN` must point at the Caddy host before first run.
- Ports 80 and 443 must be reachable from the public internet (Let's Encrypt's HTTP-01 challenge needs port 80).

For `localhost` or internal hostnames, Caddy issues an internal cert — your browser will warn unless you trust Caddy's local CA (`docker exec -it tangle-caddy-1 caddy trust`).

## Webhooks aren't firing

Open the webhook in the UI → **Recent deliveries**. If you see status `null` and no rows: the dispatcher itself errored — check the API logs (`docker logs tangle-api-1`). If you see attempts but the receiver isn't picking them up:

- Verify the URL — Tangle accepts `http://` and `https://`. No protocol means rejection at create time.
- Check the receiver's signature validation. Tangle sends `X-Tangle-Signature: sha256=<hmac>` over the exact request body.
- Verify the event subscription. A webhook with `events: ["push"]` won't fire on issue events.

## "Cannot fast-forward — base has diverged"

Tangle's PR merge in v1 is fast-forward only. If `main` has commits the PR's head doesn't, you can't FF. Rebase locally:

```sh
git checkout my-branch
git fetch origin
git rebase origin/main
git push --force-with-lease
```

…then the merge button will succeed. (`--force-with-lease` is safer than `--force` — it refuses to overwrite if someone else pushed to your branch in the meantime.)

## API boots but throws `[tangle] FATAL: SECRET is set to its default value`

You're in `NODE_ENV=production` with the default `SECRET`. Set a real one:

```sh
SECRET=$(openssl rand -hex 32)
```

…and restart. The fatal exit is intentional — JWTs signed with the known default would be forgeable by anyone who's read the source.

## MCP server says "TANGLE_MCP_USER='alice' not found"

The override resolves the user by username or email. Make sure `alice` exists and isn't soft-deleted:

```sh
docker exec -i postgres-dev psql -U postgres -d tangle -c \
  "SELECT id, username, deleted_at FROM users WHERE username = 'alice'"
```

Drop `TANGLE_MCP_USER` entirely to fall back to the instance owner.

## Getting deeper

- API logs: `docker logs tangle-api-1` (or the bun process's stderr in dev)
- Web logs: `docker logs tangle-web-1`
- Caddy logs: `docker logs tangle-caddy-1`
- Postgres health: `docker exec tangle-postgres-1 pg_isready`
- Audit trail: every auth-relevant event is logged to the `audit_events` table — `SELECT * FROM audit_events ORDER BY id DESC LIMIT 50`
