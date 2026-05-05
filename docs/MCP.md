# MCP server

Tangle ships a Model Context Protocol server that exposes the same domain operations the API does, but over JSON-RPC stdio. Point an MCP-aware AI assistant at it and it can list repos, read code, open issues, merge PRs, and more.

## Run it

```sh
bun run mcp
# or directly:
bun src/mcp/serve.ts
```

The server speaks LSP-style framed JSON-RPC on stdin/stdout. All human-readable output goes to stderr.

## Identity

By default the MCP runs as the **instance owner** — i.e., whoever signed up first. Override with:

```sh
TANGLE_MCP_USER=alice bun src/mcp/serve.ts        # acts as user "alice"
TANGLE_MCP_USER=anonymous bun src/mcp/serve.ts    # only public data
```

Every domain tool runs that user's permission gate (`resolveRepoAccess`) — so a non-owner identity can only touch repos they actually have access to.

## Tool catalog

**Built-ins (atlas)** — `db.query`, `db.schemas`, `migrate.{status,up,down}`, `health.check`, `logs.tail`.

**Tangle domain (32 tools)**:

| Group | Tools |
|-------|-------|
| Identity | `tangle.users.me`, `tangle.users.search` |
| Repos | `tangle.repos.{list_mine,list_by_owner,get,create,delete,fork,set_mirror}` |
| Browse | `tangle.git.{refs,tree,blob,commits,readme,clone_url}` |
| Issues | `tangle.issues.{list,get,create,update,comment,list_comments}` |
| Pulls | `tangle.pulls.{list,get,create,diff,merge,comment}` |
| Labels | `tangle.labels.{list,create}` |
| Releases | `tangle.releases.list` |
| Webhooks | `tangle.webhooks.{list,deliveries}` |

Each tool advertises a JSON-Schema `inputSchema` — `tools/list` returns the catalog with parameter docs.

## Wiring it into Claude Code / other MCP hosts

Point the host at the entry script. Example for `~/.config/claude/mcp.json`:

```json
{
  "tangle": {
    "command": "bun",
    "args": ["src/mcp/serve.ts"],
    "cwd": "/path/to/tangle",
    "env": {
      "DATABASE_URL": "postgres://postgres:postgres@localhost:5432/tangle",
      "REPO_DIR": "/path/to/tangle/.tangle/repos"
    }
  }
}
```

Common workflows:

- **"Show me what changed in the auth module last week"** — `tangle.git.commits` + `tangle.git.blob`.
- **"Triage the open issues for repo X"** — `tangle.issues.list` + `tangle.issues.update` to label/close in bulk.
- **"Fork upstream/foo, open a PR"** — `tangle.repos.fork` + `tangle.pulls.create` end-to-end.
- **"Why is webhook delivery failing?"** — `tangle.webhooks.deliveries` for the recent attempt log.

## Implementation

`src/mcp/serve.ts` shares its config (`DATABASE_URL`, `REPO_DIR`, storage settings) with the API process. Domain tools call directly into the same modules `src/server.ts` mounts as routes — no HTTP round-trip, no double-implementation. The auth model is owner-by-default rather than per-request because the MCP runs in-process on the operator's machine.
