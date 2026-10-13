# syntax=docker/dockerfile:1
#
# Telemetry collector release image. One image serves every Node process of a
# release: the collector (default command), the migration job
# (node src/migrate.js), the compactor (node src/jobs/compactor.js) and the
# tools (node tools/export.js, tools/verify-*.js). Releases are referenced by an
# immutable tag (sha-<commit>) or digest, never by a moving tag.
#
# The base is pinned to an exact Node and Alpine release. To pin the digest as
# well, replace the tag with tag@sha256:<index digest> from
#   docker buildx imagetools inspect node:22.23.2-alpine3.24
# and review base updates like any other dependency change (docs/operations.md).
ARG NODE_IMAGE=node:22.23.2-alpine3.24

FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

FROM ${NODE_IMAGE}
# The runtime needs only node: drop the package managers (and their bundled
# dependencies) from the final image to shrink the attack surface.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
ENV NODE_ENV=production PORT=8080 METRICS_PORT=9464
WORKDIR /app
# Application files stay owned by root and read-only for the runtime user, so
# the image works unchanged with a read-only root filesystem.
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY migrations ./migrations
COPY src ./src
COPY tools ./tools
# The archive job embeds the format specification beside the decoder.
COPY docs/trajectory-format.md ./docs/trajectory-format.md
USER node
# 8080 is the public intake behind Caddy; the metrics port is private and is
# deliberately not exposed.
EXPOSE 8080
# Liveness only (no database I/O); readiness is /readyz. Jobs and tools that
# run from this image override or disable it (compose.yml).
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -T 2 -O /dev/null "http://127.0.0.1:${PORT:-8080}/healthz" || exit 1
STOPSIGNAL SIGTERM
CMD ["node", "src/server.js"]
