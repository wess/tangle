FROM oven/bun:1-alpine AS deps
WORKDIR /app

# Install workspace deps in a separate layer so source-only changes
# don't blow the cache.
COPY package.json bun.lock ./
COPY libs/ ./libs/
RUN bun install --frozen-lockfile --production

FROM oven/bun:1-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# OCI image metadata. org.opencontainers.image.source is what links the
# published package back to the GitHub repo — GHCR uses it for repo
# association (README, license, visibility inheritance). The CI workflow
# also injects dynamic labels (revision, created) via docker/metadata-action.
LABEL org.opencontainers.image.title="Tangle" \
      org.opencontainers.image.description="Self-hosted git server — issues, PRs, releases, webhooks, MCP. Bun + React + Postgres." \
      org.opencontainers.image.source="https://github.com/wess/tangle" \
      org.opencontainers.image.url="https://github.com/wess/tangle" \
      org.opencontainers.image.licenses="MIT"

# `git` is the upstream binary — Tangle's Smart-HTTP routes shell out
# to `git upload-pack` / `git receive-pack` for protocol parity.
RUN apk add --no-cache git

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/libs ./libs
COPY package.json bun.lock ./
COPY src/ ./src/
COPY migrations/ ./migrations/
COPY tsconfig.json ./

EXPOSE 3000 3001

# `command:` in compose.yaml selects between api / web entry points.
CMD ["bun", "src/server.ts"]
