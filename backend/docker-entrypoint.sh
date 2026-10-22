#!/bin/sh
# Container entrypoint: apply pending migrations to the authoritative database
# (PostgreSQL, ADR-0002), then start the API. `migrate deploy` only applies
# already-generated migrations — it never prompts or alters the schema itself —
# so it is safe to run on every boot. DATABASE_URL comes from the environment
# (set by docker-compose to the internal `db` host).
set -e

echo "[entrypoint] Applying database migrations (prisma migrate deploy)…"
node_modules/.bin/prisma migrate deploy --schema backend/src/prisma/schema.prisma

echo "[entrypoint] Starting API…"
exec node backend/dist/main.js
