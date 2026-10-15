# Backend image (NestJS). Built from the REPOSITORY ROOT as context because this is
# an npm-workspaces monorepo — the single package-lock.json lives at the root
# (compose sets context: . , dockerfile: backend/Dockerfile). Deployment target is
# local Docker Compose (ADR-0008); image-size optimisation is noted as future work
# in docs/deployment.md rather than pursued here.

# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app
# Prisma's query engine needs OpenSSL on Alpine.
RUN apk add --no-cache openssl
# Manifests first so `npm ci` is cached until a dependency actually changes.
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
RUN npm ci
# Shared TS base config (backend/tsconfig.json extends ../tsconfig.base.json).
COPY tsconfig.base.json ./tsconfig.base.json
# Backend source, then generate the Prisma client and compile to dist/.
COPY backend ./backend
RUN npm run prisma:generate --workspace backend \
  && npm run build --workspace backend

# ── Runtime stage ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache openssl \
  && addgroup -S nodejs && adduser -S nodejs -G nodejs
# node_modules carries the hoisted deps, the generated Prisma client, and the
# Prisma CLI used by the entrypoint migration step.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/backend/package.json ./backend/package.json
COPY --from=build /app/backend/dist ./backend/dist
# Schema + migrations are needed at runtime for `prisma migrate deploy`.
COPY --from=build /app/backend/src/prisma ./backend/src/prisma
# Local attachment object store (ADR-0007); a named volume is mounted over this.
RUN mkdir -p /app/backend/var/attachments && chown -R nodejs:nodejs /app/backend/var
COPY backend/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
USER nodejs
EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
