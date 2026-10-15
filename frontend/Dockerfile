# Frontend image (React + Vite → static assets served by nginx). Built from the
# REPOSITORY ROOT as context (monorepo lockfile at the root), like the backend.
#
# VITE_API_URL is baked in at BUILD time (Vite inlines import.meta.env), and the
# value must be reachable from the user's BROWSER — i.e. the backend's
# host-published address (http://localhost:<BACKEND_PORT>), not the internal
# Docker hostname. compose passes it as a build arg.

# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app
ARG VITE_API_URL=http://localhost:3100
ENV VITE_API_URL=$VITE_API_URL
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
RUN npm ci
COPY frontend ./frontend
RUN npm run build --workspace frontend

# ── Runtime stage (static web server) ────────────────────────────────────────
FROM nginx:1.27-alpine AS runtime
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/frontend/dist /usr/share/nginx/html
EXPOSE 80
