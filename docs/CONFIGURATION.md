# Configuration

The API process reads its configuration entirely from environment variables. `.env.example` is the source of truth — copy it to `.env` and edit. Every var below maps 1:1 to a `defineConfig` entry in `src/server.ts`.

| Var                  | Default                                | Notes |
|----------------------|----------------------------------------|-------|
| `PORT`               | `3000`                                 | API listen port. |
| `WEB_PORT`           | `3001`                                 | SPA listen port. |
| `API_URL`            | `http://localhost:3000`                | Where the SPA proxies `/api/*` to. |
| `SECRET`             | `change-me-in-production`              | JWT signing key. **The API refuses to start in non-development if this is the default or shorter than 32 chars.** |
| `DATABASE_URL`       | `postgres://postgres:postgres@localhost:5432/tangle` | Postgres connection string. |
| `REPO_DIR`           | `./.tangle/repos`                      | Where bare git repos live on disk. **Persistent volume in production.** |
| `STORAGE_DRIVER`     | `local`                                | `local` (single-host disk) or `s3` (any S3-compatible bucket). Used for attachment blobs only — repo content is always on disk. |
| `STORAGE_LOCAL_DIR`  | `./.tangle/blobs`                      | Used when `STORAGE_DRIVER=local`. |
| `S3_ENDPOINT`        | `http://localhost:4000`                | Used when `STORAGE_DRIVER=s3`. |
| `S3_BUCKET`          | `tangle`                               | |
| `S3_REGION`          | `us-east-1`                            | |
| `S3_ACCESS_KEY`      | `tangleadmin`                          | |
| `S3_SECRET_KEY`      | `tangleadmin`                          | |
| `APP_URL`            | `http://localhost:3001`                | Public base URL where the SPA is served. Used to build links in outgoing emails. |
| `RESEND_API_KEY`     | (empty)                                | When empty, outgoing email is logged to the API console instead of sent. |
| `RESEND_FROM`        | `Tangle <onboarding@resend.dev>`       | Verified sender on your Resend account. |
| `RP_ID`              | `localhost`                            | WebAuthn relying-party ID — bare hostname, no protocol or port. |
| `RP_NAME`            | `Tangle`                               | |
| `RP_ORIGIN`          | `http://localhost:3001`                | |
| `MAX_UPLOAD_BYTES`   | `1073741824` (1 GiB)                   | Per-request body cap. Bun buffers the body before the handler runs, so this is also a memory ceiling per concurrent push or asset upload. |
| `TRUSTED_PROXIES`    | (empty)                                | Comma-separated IPs/CIDRs whose `X-Forwarded-For` is honored. Anything else is ignored — safe by default. |
| `NODE_ENV`           | `development`                          | The API refuses to start with the default `SECRET` unless this is `development`. |

Compose-only variables (used in `compose.yaml`, never read by the API directly):

| Var                | Notes |
|--------------------|-------|
| `POSTGRES_PASSWORD`| Strong password for the local Postgres container. |
| `DOMAIN`           | Public hostname Caddy serves on. Set to your domain in production (Caddy auto-provisions Let's Encrypt). |
