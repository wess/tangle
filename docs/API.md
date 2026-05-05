# API reference

Every JSON endpoint lives under `/api/*` from the SPA's perspective, or `/*` directly on the API process. Authentication is `Authorization: Bearer <token>` — either a JWT issued by `/login` / `/signup` or a personal access token (`tangle_pat_…`).

JSON bodies and query params accept both `snake_case` and `camelCase` for backwards-compatible aliases.

## Auth

| Method | Path                 | Auth | Notes |
|--------|----------------------|------|-------|
| GET    | `/setup`             | none | `{ needsSetup: boolean }` — true when no users exist yet. |
| POST   | `/signup`            | none | First signup needs no invite; subsequent signups must pass `invite_token`. |
| POST   | `/login`             | none | Returns `{ token }` or `{ mfa_required, mfa_token }` if 2FA is on. |
| POST   | `/login/mfa`         | none | Trade an `mfa_token` plus `code` (or `backup_code`) for a session. |
| GET    | `/me/sessions`       | yes  | List active sessions for the caller; `is_current` flags the calling JWT. |
| DELETE | `/me/sessions/:id`   | yes  | Revoke a specific session. |

## Profile

| Method | Path           | Auth | Notes |
|--------|----------------|------|-------|
| GET    | `/me`          | yes  | The current user. |
| PATCH  | `/me`          | yes  | Update `name`, `email`, `username`, `bio`, `discoverable`. Identity changes re-issue the session JWT. |
| POST   | `/me/password` | yes  | Change password; revokes other sessions on success. |
| GET    | `/users/search?q=` | yes | Substring match on username/name (discoverable users only). |
| GET    | `/u/:username` | yes  | Public profile lookup. |

## Orgs

| Method | Path                        | Auth | Notes |
|--------|-----------------------------|------|-------|
| GET    | `/orgs`                     | yes  | Orgs the caller belongs to. |
| POST   | `/orgs`                     | yes  | Create. Caller becomes the org's owner. |
| GET    | `/orgs/:login`              | yes  | Org details. |
| PATCH  | `/orgs/:login`              | yes  | Owner-only — edit name/description. |
| GET    | `/orgs/:login/members`      | yes  | List members. |
| POST   | `/orgs/:login/members`      | yes  | Owner-only — add by `username`. |
| DELETE | `/orgs/:login/members/:username` | yes | Owner-only — refuses to remove the last owner. |

## Repos

| Method | Path                          | Auth | Notes |
|--------|-------------------------------|------|-------|
| GET    | `/me/repos`                   | yes  | Caller-accessible repos (owned + org + collaborator). |
| GET    | `/repos/:owner`               | yes  | Public repos under `:owner`, plus private ones the caller has access to. |
| POST   | `/repos`                      | yes  | Create. `owner` defaults to the caller's username; can be an org login the caller belongs to. |
| GET    | `/repos/:owner/:name`         | yes  | Repo details + the caller's `viewer_role`. |
| PATCH  | `/repos/:owner/:name`         | yes  | Admin-only — description, privacy, default branch, archive flag. |
| DELETE | `/repos/:owner/:name`         | yes  | Admin-only — soft-deletes the row, drops the bare repo from disk. |

## Collaborators

| Method | Path                                              | Auth | Notes |
|--------|---------------------------------------------------|------|-------|
| GET    | `/repos/:owner/:name/collaborators`               | yes  | Admin-only. |
| POST   | `/repos/:owner/:name/collaborators`               | yes  | By `username` (immediate) or `email` (pending until that user signs up). Roles: `reader`, `writer`, `admin`. |
| PATCH  | `/repos/:owner/:name/collaborators/:id`           | yes  | Change role. |
| DELETE | `/repos/:owner/:name/collaborators/:id`           | yes  | Revoke. |

## Issues & comments

| Method | Path                                                              | Auth | Notes |
|--------|-------------------------------------------------------------------|------|-------|
| GET    | `/repos/:owner/:name/issues?state=open\|closed\|all`              | yes  | List. |
| POST   | `/repos/:owner/:name/issues`                                      | yes  | `{ title, body? }`. Numbering shared with pulls. |
| GET    | `/repos/:owner/:name/issues/:number`                              | yes  | Full body. |
| PATCH  | `/repos/:owner/:name/issues/:number`                              | yes  | Edit (author or writer); state changes need writer access. |
| GET    | `/repos/:owner/:name/issues/:number/comments`                     | yes  | List. |
| POST   | `/repos/:owner/:name/issues/:number/comments`                     | yes  | Append. |
| PATCH  | `/repos/:owner/:name/issues/:number/comments/:id`                 | yes  | Author-only edit. |
| DELETE | `/repos/:owner/:name/issues/:number/comments/:id`                 | yes  | Author or admin. |

The same shape exists at `/pulls/:number/...` for pull-request comments.

## Pulls

| Method | Path                                            | Auth | Notes |
|--------|-------------------------------------------------|------|-------|
| GET    | `/repos/:owner/:name/pulls?state=...`           | yes  | List. |
| POST   | `/repos/:owner/:name/pulls`                     | yes  | `{ title, body?, head, base?, head_repo_id? }`. |
| GET    | `/repos/:owner/:name/pulls/:number`             | yes  | Full PR. |
| PATCH  | `/repos/:owner/:name/pulls/:number`             | yes  | Edit / open / close. |

## Stars

| Method | Path                                | Auth | Notes |
|--------|-------------------------------------|------|-------|
| GET    | `/me/stars`                         | yes  | Caller's starred repos. |
| POST   | `/repos/:owner/:name/star`          | yes  | Idempotent. |
| DELETE | `/repos/:owner/:name/star`          | yes  | Idempotent. |

## Releases

| Method | Path                                                | Auth | Notes |
|--------|-----------------------------------------------------|------|-------|
| GET    | `/repos/:owner/:name/releases`                      | yes  | List. |
| POST   | `/repos/:owner/:name/releases`                      | yes  | Writer-only. |
| GET    | `/repos/:owner/:name/releases/:id`                  | yes  | Includes assets. |
| PATCH  | `/repos/:owner/:name/releases/:id`                  | yes  | Writer-only. |
| DELETE | `/repos/:owner/:name/releases/:id`                  | yes  | Writer-only. |
| POST   | `/repos/:owner/:name/releases/:id/assets`           | yes  | `multipart/form-data` with a single `file` field. |

## SSH keys

| Method | Path                | Auth | Notes |
|--------|---------------------|------|-------|
| GET    | `/me/ssh-keys`      | yes  | List. |
| POST   | `/me/ssh-keys`      | yes  | `{ title, key }`. Deduped by SHA256 fingerprint across the whole instance. |
| DELETE | `/me/ssh-keys/:id`  | yes  | Remove. |

## Personal access tokens

| Method | Path             | Auth          | Notes |
|--------|------------------|---------------|-------|
| GET    | `/me/apps`       | yes           | List (no plaintext tokens). |
| POST   | `/me/apps`       | yes (browser) | PATs cannot create other PATs. |
| DELETE | `/me/apps/:id`   | yes (browser) | Same restriction. |

## Webhooks

| Method | Path                                                | Auth | Notes |
|--------|-----------------------------------------------------|------|-------|
| GET    | `/repos/:owner/:name/webhooks`                      | yes  | Admin-only. |
| POST   | `/repos/:owner/:name/webhooks`                      | yes  | Admin-only. |
| PATCH  | `/repos/:owner/:name/webhooks/:id`                  | yes  | Admin-only. |
| DELETE | `/repos/:owner/:name/webhooks/:id`                  | yes  | Admin-only. |
| GET    | `/repos/:owner/:name/webhooks/:id/deliveries`       | yes  | Recent delivery log. |

## Admin (owner-only)

| Method | Path                  | Auth     | Notes |
|--------|-----------------------|----------|-------|
| GET    | `/admin/invites`      | owner    | List. |
| POST   | `/admin/invites`      | owner    | Returns the plaintext token **once**. |
| DELETE | `/admin/invites/:id`  | owner    | Revoke. |

## Git Smart-HTTP (not under `/api`)

```
GET  /<owner>/<repo>.git/info/refs?service=git-upload-pack
GET  /<owner>/<repo>.git/info/refs?service=git-receive-pack
POST /<owner>/<repo>.git/git-upload-pack
POST /<owner>/<repo>.git/git-receive-pack
```

HTTP Basic auth with a PAT in the password slot. The username is ignored.
