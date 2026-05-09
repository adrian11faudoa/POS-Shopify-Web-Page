# services/api/Dockerfile
# Multi-stage production build for the API service

# ─── Base ────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS base
RUN apk add --no-cache libc6-compat
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app

# ─── Dependencies ────────────────────────────────────────────────────────────
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/types/package.json ./packages/types/
COPY packages/database/package.json ./packages/database/
COPY packages/config/package.json ./packages/config/
COPY services/api/package.json ./services/api/
RUN pnpm install --frozen-lockfile

# ─── Development ─────────────────────────────────────────────────────────────
FROM base AS development
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/*/node_modules ./packages/
COPY . .
EXPOSE 4000
CMD ["pnpm", "--filter", "@snackpos/api", "dev"]

# ─── Builder ─────────────────────────────────────────────────────────────────
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm --filter @snackpos/types build
RUN pnpm --filter @snackpos/database build
RUN pnpm --filter @snackpos/api build

# ─── Production ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS production
RUN apk add --no-cache dumb-init
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

# Create non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 snackpos

WORKDIR /app

# Copy only production dependencies and built files
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder --chown=snackpos:nodejs /app/services/api/dist ./services/api/dist
COPY --from=builder --chown=snackpos:nodejs /app/packages/types/dist ./packages/types/dist
COPY --from=builder --chown=snackpos:nodejs /app/packages/database/dist ./packages/database/dist
COPY --from=builder /app/services/api/package.json ./services/api/
COPY --from=builder /app/package.json ./

# Prune dev dependencies
RUN pnpm prune --prod

USER snackpos

EXPOSE 4000

ENV NODE_ENV=production
ENV PORT=4000

# Use dumb-init for proper signal handling
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "services/api/dist/server.js"]

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:4000/health', r => r.statusCode === 200 ? process.exit(0) : process.exit(1)).on('error', () => process.exit(1))"
