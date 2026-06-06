# Changelog

All notable changes to Tangle are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.11] - 2026-05-31

### Added

- Code search: `GET /api/repos/:owner/:name/search?q=...` runs `git grep`
  on the default branch (or `?ref=`) within the repo's bare path. The
  query is passed to `git grep --fixed-strings` as a single argv element
  via `Bun.spawn` — it is never interpolated into a shell, so it cannot
  inject commands. Results are grouped by file and capped at 200 matched
  lines across 50 files; the response carries a `truncated` flag when a
  cap is hit. Visibility and permissions are enforced with the same gate
  as the file-browsing routes, so private repos answer "not found" to
  callers without read access.
- SPA search box and grouped results on the repo Code tab, styled to
  match the existing browse UI.
- Test coverage for `git grep` hit grouping, the empty-result path, the
  literal (non-shell, non-regex) handling of metacharacters in queries,
  and the private-repo permission-rejection path.

### Planned

- SSH transport for clone/fetch/push (only Smart-HTTP today).
- Cross-repo pull requests (PRs between forks). The diff endpoint already
  flags `cross_repo`; merging across repos is not yet implemented.

## [0.1.10] - 2026-05-31

### Fixed

- Schema typecheck: removed string `now()` and numeric `bigint` defaults from
  the typed schema so `tsc --noEmit` passes. These defaults are enforced by the
  migration DDL and were ignored at runtime; only the database-level defaults
  are authoritative.

### Changed

- Biome scripts (`lint`, `format`, `check` and their `:fix` variants) now target
  `src/` instead of the non-existent `packages/`, so the lint gate inspects the
  actual codebase.

### Added

- `typecheck` (`tsc --noEmit`) and `build` scripts wired as release gates.
- Initial automated test suite under `tests/` covering auth token hashing,
  repository permission resolution, git Smart-HTTP pkt-line framing, webhook
  HMAC signing and body encoding, and schema integrity.
- `ci.yml` workflow running install, typecheck, lint, and tests on pull
  requests and pushes to main, independent of the image publish workflow.
- This changelog.

## [0.1.9] - 2026-05-28

### Added

- Self-hosted git server: repositories, organizations, collaborators, and
  fine-grained read/write/admin access resolution.
- Git Smart-HTTP transport (clone, fetch, push) via `git-upload-pack` and
  `git-receive-pack` over stateless RPC.
- Issues, pull requests with merge support, comments, labels, stars, and
  releases with downloadable assets.
- Authentication: password login, sessions, personal access tokens, TOTP MFA,
  and WebAuthn credentials.
- Invites, password resets, and instance settings.
- Outbound webhooks with GitHub-compatible `X-Tangle-Signature` HMAC signing
  and delivery history.
- Repository mirroring.
- React single-page web UI and an MCP server for AI-assisted browsing.
- Docker image published to GHCR, version-driven by `package.json`.

[0.1.11]: https://github.com/wess/tangle/releases/tag/v0.1.11
[0.1.10]: https://github.com/wess/tangle/releases/tag/v0.1.10
[0.1.9]: https://github.com/wess/tangle/releases/tag/v0.1.9
