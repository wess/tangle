import type { Tool } from "@atlas/mcp"
import type { TangleMcpContext } from "./context.ts"
import { repoTools } from "./tools/repos.ts"
import { browseTools } from "./tools/browse.ts"
import { issueTools } from "./tools/issues.ts"
import { pullTools } from "./tools/pulls.ts"
import { miscTools } from "./tools/misc.ts"
import { webhookTools } from "./tools/webhooks.ts"

// All Tangle-domain MCP tools, ready to mix with atlas's built-in
// (db.query, migrate.*, health.check, …) tools in the entry script.
export const tangleTools = (ctx: TangleMcpContext): Tool[] => [
  ...repoTools(ctx),
  ...browseTools(ctx),
  ...issueTools(ctx),
  ...pullTools(ctx),
  ...miscTools(ctx),
  ...webhookTools(ctx),
]

export type { TangleMcpContext } from "./context.ts"
export { resolveMcpUser } from "./context.ts"
