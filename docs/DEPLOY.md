# Deploy

Tangle ships with a `Dockerfile` and `compose.yaml` that runs the full stack — Postgres, the API, the SPA-serving web container, and Caddy as the public-facing reverse proxy.

## One-host docker-compose

```sh
cp .env.example .env
# Set DOMAIN (or use :80 for plain-HTTP testing), POSTGRES_PASSWORD,
# SECRET (use `openssl rand -hex 32`), and RESEND_API_KEY.
docker compose up -d
```

Caddy serves on ports `80` and `443`. When `DOMAIN` is a real hostname, certs are auto-provisioned via Let's Encrypt; for `*.localhost` or an internal domain Caddy issues an internal cert.

The bare git repos and attachment blobs live in named docker volumes (`repos`, `blobs`). Postgres data lives in `pgdata`. Back these up.

## Without docker

Bun + Postgres on a single host:

1. Install Bun (`curl -fsSL https://bun.sh/install | bash`)
2. Install Postgres 16 and create the `tangle` database
3. Install `git` (the API shells out to `git-upload-pack` / `git-receive-pack`)
4. `cp .env.example .env` — set `SECRET`, `DATABASE_URL`, `REPO_DIR`, `APP_URL`, `RESEND_API_KEY`, `NODE_ENV=production`
5. `bun install`
6. Run the API and web processes (e.g. with systemd):
   ```
   bun src/server.ts        # API
   bun src/web/serve.ts     # web
   ```
7. Front with your reverse proxy of choice. Critical: `*.git/*` paths must reach the API directly — see `caddyfile` for the rule.

## Production checklist

- `SECRET` is a strong random value, **not** the default
- `NODE_ENV=production` (the API refuses to start with the default `SECRET` otherwise)
- `RESEND_API_KEY` is set, or you've swapped the emailer in `src/email/index.ts`
- `REPO_DIR` is a persistent volume — losing it loses every push
- `TRUSTED_PROXIES` matches the IPs/CIDR your reverse proxy uses (or leave empty if there is none)
- DNS for `RP_ID` matches `RP_ORIGIN` — passkeys are pinned to the RP and won't roam between hostnames
