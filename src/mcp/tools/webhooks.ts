import { defineTool } from "@atlas/mcp"
import { findRepo, resolveRepoAccess } from "../../permissions/index.ts"
import { createWebhook, VALID_EVENTS } from "../../webhooks/index.ts"
import type { TangleMcpContext } from "../context.ts"

const requireUser = (ctx: TangleMcpContext): number => {
  if (ctx.userId === null) throw new Error("This tool requires authentication. Set TANGLE_MCP_USER.")
  return ctx.userId
}

// Accept either a JSON array (some MCP clients send arrays even when the
// schema advertises a string) or a comma/space-separated string. Omitted
// -> ["push"], the sensible default for wiring a push integration. The
// createWebhook core does the real per-event validation.
const normalizeEvents = (events: unknown): string[] => {
  if (events === undefined || events === null) return ["push"]
  if (Array.isArray(events)) return events.map(e => String(e).trim()).filter(Boolean)
  return String(events)
    .split(/[\s,]+/)
    .map(e => e.trim())
    .filter(Boolean)
}

// Write-category webhook tools. `tangle.webhooks.create` calls the same
// in-process createWebhook core the REST route uses, so an agent can wire
// an outbound webhook (e.g. tangle -> kettle push) over MCP without
// touching the DB directly. The list/deliveries read tools live in
// misc.ts alongside the other small read helpers.
export const webhookTools = (ctx: TangleMcpContext) => [
  defineTool({
    name: "tangle.webhooks.create",
    description:
      "Create an outbound webhook on a repository (admin access required). " +
      `events defaults to ["push"]; valid events: [${[...VALID_EVENTS].join(", ")}].`,
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string", description: "The repository name." },
        url: { type: "string", description: "Target URL. http(s); http is allowed for LAN targets." },
        events: {
          type: "string",
          description: 'Comma-separated event subscriptions. Defaults to "push" when omitted.',
        },
        secret: { type: "string", description: "Optional HMAC signing secret (X-Tangle-Signature)." },
      },
      required: ["owner", "repo", "url"],
    },
    handler: async ({ owner, repo, url, events, secret }: any) => {
      const userId = requireUser(ctx)
      const found = await findRepo(ctx.db, String(owner), String(repo))
      if (!found) throw new Error(`Repo ${owner}/${repo} not found`)
      const access = await resolveRepoAccess(ctx.db, found, userId)
      if (!access.admin) throw new Error("Repo admin access required")

      const result = await createWebhook(ctx.db, found.id, userId, {
        url: typeof url === "string" ? url : undefined,
        events: normalizeEvents(events),
        secret: typeof secret === "string" ? secret : null,
      })
      if (!result.ok) throw new Error(result.message)
      return result.webhook
    },
  }),
]
