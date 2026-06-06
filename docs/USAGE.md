# Common workflows

Recipes for the things you'll actually do day-to-day.

## Cloning and pushing

Tangle speaks **HTTP Smart-Protocol** with HTTP Basic auth. Use any string for the username and a personal access token (Settings → Personal access tokens) as the password.

```sh
# Clone (PAT in URL — convenient for one-off setup)
git clone http://wess:tangle_pat_…@localhost:3000/wess/myrepo.git

# Or stash creds via git's credential helper
git config --global credential.helper store
git clone http://localhost:3000/wess/myrepo.git
# Enter PAT when prompted; the helper remembers it.
```

Public repos clone without auth. Pushes always require a token with `repo` or `repo:write` scope.

## Opening a pull request

Tangle's PR model is fast-forward only in v1 — the head branch must be ahead of base, no diverging history. If you can't FF, rebase locally and push.

```sh
git checkout -b add-readme
echo "# hello" > README.md
git add README.md && git commit -m "add readme"
git push -u origin add-readme
```

Then in the web UI: **Pulls → New pull request → Compare add-readme → main → Open**.

The diff view shows files changed, additions/deletions, and the unified patch with `+`/`-` colored. Hit **Merge (fast-forward)** to land it.

## Forking a repo

The web UI **Fork** button (top right of any repo header) clones the bare repo into your namespace via `git clone --bare --no-hardlinks`. Forks track their parent via the `fork_of` column but are otherwise fully independent.

You can also fork via the MCP:

```sh
# Via the MCP, if your AI assistant has it wired up:
> "Fork wess/upstream into my org acme"
```

## Mirroring an external repo

Useful for keeping a private backup of a public GitHub project on your home server.

1. Create an empty repo in Tangle (Settings → mark it private if you want)
2. **Settings → mirror_url** — paste `https://github.com/golang/go.git`
3. The first sync runs immediately; subsequent syncs run every 15 minutes via the periodic sweep

Errors land in `mirror_last_error` and are visible in the UI.

## Running the MCP server alongside an AI assistant

The MCP server gives an AI assistant 32 domain tools — list repos, read code, open PRs, merge them, view webhook delivery logs. The full catalog is in [MCP.md](MCP.md).

```sh
bun run mcp                                       # acts as the instance owner
TANGLE_MCP_USER=alice bun run mcp                 # acts as user "alice"
TANGLE_MCP_USER=anonymous bun run mcp             # public-only, no writes
```

For Claude Code, add to `~/.config/claude/mcp.json`:

```json
{
  "tangle": {
    "command": "bun",
    "args": ["src/mcp/serve.ts"],
    "cwd": "/path/to/tangle"
  }
}
```

## Inviting someone

Settings → Admin → Invites → **Generate invite**. The plaintext token is shown **once**. Email it to the invitee — they paste it on the signup page.

If you set an email on the invite, only that email can redeem it. Leave it blank for an open invite.

## Webhooks

Settings → Webhooks → Add webhook on any repo. Tangle fires `push`, `issues`, `pull_request`, `release`, `star`, `status` events with HMAC-SHA256 signatures (`X-Tangle-Signature: sha256=…`).

The delivery log (Webhooks → click into one → Recent deliveries) shows status code, response body, and latency for the last 50 attempts.

## Rotating a personal access token

Settings → Personal access tokens → **Revoke** the old one → **Generate** a new one. The PAT is hashed with SHA-256 before storage, so a database leak doesn't expose existing tokens — but a revoke is still the right move if a token might be compromised.

Update any `git remote` URLs that embed the old PAT, and check `~/.git-credentials` if you used the credential store helper.

## Deleting a repo

Settings → Danger zone → Delete. Tangle:

1. Sets `deleted_at` on the row (so in-flight clones see "not found" immediately)
2. Removes the bare repo directory from disk

There is **no undo**. For private mirrors of important things, consider archiving (Settings → Archive) instead — that drops write access without removing data.

## Theming

The sidebar footer has a sun/moon toggle. Preference persists to `localStorage` per browser. The `data-theme` attribute on `<html>` flips between `light` and `dark`; both palettes are Nord (Snow Storm + Frost for light, Polar Night + Frost for dark).

## Backing up

Two things to back up:

1. **Postgres** — `pg_dump tangle | gzip > tangle.sql.gz`
2. **Repo directory** — the `repos` named volume in docker-compose, or `${REPO_DIR}` for local installs

Both should go in your usual home-lab backup rotation. Lose the repos directory and clones survive on contributor machines, but the on-server history is gone.

Restoring is the reverse — `gunzip -c tangle.sql.gz | psql tangle` and copy the bare-repo directory back. The next API boot picks them up.
