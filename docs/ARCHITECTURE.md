# Architecture

Tangle ships as two long-lived Bun processes plus Postgres and (optionally) an S3-compatible bucket. Repository content lives on disk as plain bare git repos.

## Processes

| Process | Entry            | Port  | What it serves                                                                                    |
|---------|------------------|-------|---------------------------------------------------------------------------------------------------|
| API     | `src/server.ts`  | 3000  | All JSON routes (`/login`, `/repos/...`, `/me/...`) **and** git Smart-HTTP (`/<owner>/<repo>.git/...`). |
| Web     | `src/web/serve.ts` | 3001 | The SPA (`src/web/app.tsx`); proxies `/api/*` through to the API.                                 |

In production, Caddy fronts both. `*.git/*` paths bypass the SPA proxy and go straight to the API; everything else flows through the web container.

## Storage

| Concern                                | Where it lives                                         |
|----------------------------------------|--------------------------------------------------------|
| User accounts, repos, issues, comments | Postgres (the system of record)                        |
| Bare git repositories                  | Disk, under `REPO_DIR/<owner>/<repo>.git`              |
| Avatars, release assets                | Pluggable: `s3` driver or `local` driver (single host) |

The git Smart-HTTP route module is the *only* code that reads or writes the bare repos. Everything else (issues, comments, etc.) goes through Postgres.

## Request pipeline

`src/server.ts` is the composition root. It:

1. Builds a typed config via `@atlas/config`
2. Opens a Postgres connection via `@atlas/db`
3. Creates a `StorageHandle` for attachment blobs
4. Resolves and creates `REPO_DIR`
5. Runs migrations from `./migrations`
6. Registers routes from each feature module
7. Starts `Bun.serve` with security headers wired around the router

Each feature module under `src/<feature>/index.ts` exports a single factory — `authRoutes`, `userRoutes`, `repoRoutes`, `gitRoutes`, etc. — that takes `(db, secret, ...)` and returns an array of routes.

## Data model

- `users` (`username` is unique and shares a namespace with `orgs.login`)
- `sessions` — server-side row for every issued JWT, keyed by `jti`; revocation flips a column
- `apps` — personal access tokens; stored as SHA-256 hash
- `ssh_keys` — OpenSSH public keys, deduped by SHA256 fingerprint
- `orgs`, `org_members`
- `repos` — `(owner_kind, owner_id, owner_login, name)` with `UNIQUE(owner_login, name)`
- `repo_collaborators` — explicit per-repo grants; can be by `user_id` or by pending `email`
- `issues`, `pulls` — share a per-repo numbering pool (mirrors GitHub UX)
- `comments` — polymorphic on `(subject_kind, subject_id)` covering both issues and pulls
- `stars`, `releases`, `release_assets`, `webhooks`, `webhook_deliveries`
- `audit_events`, `rate_limits`, `invites`, `password_resets`, `webauthn_*`

Schema lives in two places — `src/schema/index.ts` (for `@atlas/db` query builders) **and** `migrations/<n>_<name>/{up,down}.sql`. Migrations are the source of truth at runtime.

## Authentication

Three credential types, all funneled through `requireAuth` (`src/auth/guard.ts`):

| Channel              | Identifier            | Notes                                                              |
|----------------------|-----------------------|--------------------------------------------------------------------|
| Web session          | JWT with `jti` claim  | Backed by a `sessions` row; revocable                              |
| Personal access token| `tangle_pat_…` opaque | Scoped (`repo`, `repo:read`, `repo:write`, `admin`); used by CLI git|
| Git over HTTP Basic  | PAT in password field | Decoded inline by `src/git/index.ts` — passwords are not accepted  |

## Permissions

`src/permissions/index.ts` resolves effective access for `(user, repo)` to a `RepoAccess` of `{ read, write, admin, role }`. The rules:

- Repo owner (user-owned) → `owner` (full)
- Org owner (org-owned) → `admin`
- Org member → `reader` baseline
- Explicit `repo_collaborators` row promotes (never demotes) above the baseline
- Public repos grant `read` to everyone, including unauthenticated callers
- Archived repos drop `write` and `admin` to read-only

## Git Smart-HTTP

`src/git/index.ts` mounts three routes on the API (note: not under `/api`):

```
GET  /<owner>/<repo>.git/info/refs?service=git-upload-pack
GET  /<owner>/<repo>.git/info/refs?service=git-receive-pack
POST /<owner>/<repo>.git/git-upload-pack
POST /<owner>/<repo>.git/git-receive-pack
```

`src/git/protocol.ts` shells out to the upstream `git-upload-pack` / `git-receive-pack` binaries with `--stateless-rpc` and pipes stdin/stdout. Authentication is HTTP Basic with a PAT in the password slot.
