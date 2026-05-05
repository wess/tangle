# Contributing

Bug reports, feature requests, and PRs are all welcome. Tangle is MIT and there's no CLA.

## Filing a bug

Open an issue at https://github.com/wess/tangle/issues with:

- What you tried (the exact `git clone` / `curl` / button click)
- What happened
- What you expected
- Tangle version (`/version` endpoint or `package.json`)
- Postgres version, OS, deployment shape (docker-compose / bare metal)

Attach API logs if relevant (`docker logs tangle-api-1`). Redact tokens before posting.

## Sending a PR

```sh
git clone https://github.com/wess/tangle
cd tangle
bun install
bun run dev
```

Make your change, run `bunx tsc --noEmit` to confirm it typechecks, then open a PR.

### Conventions (the short list)

- **Functional, no classes.** Modules export factories that return arrays of routes, or plain functions.
- **One feature per directory.** `src/<feature>/index.ts`. No mid-level `*.ts` siblings unless you've got a reason.
- **Lowercase filenames, no spaces or hyphens.** `src/sshkeys/index.ts`, not `src/ssh-keys.ts`.
- **Migrations first.** Schema changes ship as a new `migrations/<n>_<name>/{up,down}.sql` *and* an entry in `src/schema/index.ts`. Migrations are the source of truth; the TS schema is the type-system mirror.
- **Errors return `apiError(c, code, message)`.** New error codes go in `src/util/errors.ts`. Don't reach for raw `json(c, 4xx, …)`.
- **Reuse `resolveRepoAccess`.** Every repo-scoped route should pass through `findRepo` + `resolveRepoAccess`. Don't roll your own permission check.

### What to write tests against

Tangle does not yet have a test suite. If you're adding non-trivial logic — a new merge mode, a new permission rule, a new git operation — please include a `tests/<feature>.test.ts` file with at least the happy path. Use `bun test` to run.

## Areas that could use help

- **SSH protocol support** — currently HTTP-only. SSH would let people `git clone git@host:owner/repo` and need a sshd integration that authenticates against `ssh_keys`.
- **Code search** — `grep` over the bare repos at the SQL level is hard; an indexer like Sourcegraph's or a simpler ripgrep-via-RPC would be welcome.
- **Cross-repo PR merges** — currently the PR head must live in the same repo. Cross-repo would need a fetch-into-base step.
- **Theme variants** — Nord is the default; another bundled theme (Solarized, Tokyo Night) would be a fun PR.
- **i18n** — strings are hard-coded English in the SPA. Externalizing them to a JSON catalog is straightforward.

## License

By contributing, you agree your work is MIT-licensed under the same terms as the rest of the project. No CLA required.
