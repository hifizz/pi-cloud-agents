# syntax=docker/dockerfile:1
FROM node:24-slim AS web-build
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
# tsc is skipped: web/tsconfig includes test/ which needs @types/node (locally it only
# resolves via the repo-root node_modules). Typecheck runs in V0: cd web && npm run typecheck
RUN npx vite build

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src/ ./src/
COPY scripts/ ./scripts/
COPY --from=web-build /app/web/dist/ ./web/dist/
# Guard: secrets / local state must never be in the image.
RUN test ! -e .env && test -z "$(ls -A .env* 2>/dev/null)" && test ! -e data && test ! -e logs && test ! -e docs/acceptance && test ! -e vendor-ref
# Fly volumes mount as root:root. Start as root, chown /data, then drop to the
# unprivileged `node` user with setpriv (util-linux, present in Debian slim).
RUN printf '%s\n' '#!/bin/sh' 'set -e' \
  'mkdir -p "${TARSBOT_DATA_DIR:-/data}"' \
  'chown -R node:node "${TARSBOT_DATA_DIR:-/data}"' \
  'exec setpriv --reuid=node --regid=node --init-groups "$@"' > /usr/local/bin/entrypoint.sh \
  && chmod +x /usr/local/bin/entrypoint.sh
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "src/server.mjs"]
