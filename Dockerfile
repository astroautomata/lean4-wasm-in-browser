# syntax=docker/dockerfile:1.7

# Build context is the workspace assembled by .github/workflows/docker-release.yml:
#
#   lean4.js/
#   Lean4Game/lean4game/
#   Lean4Game/NNG4/
#   Lean4Game/VisualTest/
#   visual-lean-artifact/

FROM node:22-bookworm-slim AS web-builder

ARG VITE_TELEMETRY_URL=https://telemetry.leangame.autumnofautumn.com
ENV VITE_TELEMETRY_URL=${VITE_TELEMETRY_URL}

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
COPY lean4.js ./lean4.js
COPY Lean4Game/lean4game ./Lean4Game/lean4game
COPY Lean4Game/NNG4 ./Lean4Game/NNG4
COPY Lean4Game/VisualTest ./Lean4Game/VisualTest

# The reusable Lean4Game workflow produces a version-matched single-thread
# runtime and the reduced module closure used by both games.
COPY visual-lean-artifact/runtime/ ./lean4.js/public/visual-lean/runtime/
COPY visual-lean-artifact/modules/ ./lean4.js/public/visual-lean/modules/
COPY visual-lean-artifact/build-info.json ./lean4.js/public/visual-lean/build-info.json
COPY visual-lean-artifact/gamedata/NNG4/ ./Lean4Game/NNG4/.lake/gamedata/
COPY visual-lean-artifact/gamedata/VisualTest/ ./Lean4Game/VisualTest/.lake/gamedata/

WORKDIR /workspace/Lean4Game/lean4game
RUN npm ci

# Source revisions for the game build record that telemetry reports
# (scripts/sync-lean4game-client.mjs). The build context has no .git to read
# them from; RUN steps below see these as environment variables.
ARG GAME_BUILD_SITE=
ARG GAME_BUILD_CLIENT=

WORKDIR /workspace/lean4.js
RUN npm ci \
  && test -s public/visual-lean/runtime/lean.js \
  && test -s public/visual-lean/runtime/lean.wasm \
  && test -s public/visual-lean/modules/game-modules.tar.gz \
  && npm run sync-lean4game-client \
  && npm run build \
  && test -s dist/index.html \
  && test -s dist/lean4game/index.html \
  && test -s dist/lean4game/data/g/local/NNG4/game.json \
  && test -s dist/lean4game/data/g/local/VisualTest/game.json


FROM nginx:1.27-alpine AS release

COPY lean4.js/deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-builder /workspace/lean4.js/dist/ /usr/share/nginx/html/

RUN nginx -t \
  && test -s /usr/share/nginx/html/index.html \
  && test -s /usr/share/nginx/html/visual-lean/runtime/lean.wasm \
  && test -s /usr/share/nginx/html/visual-lean/modules/game-modules.tar.gz

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
