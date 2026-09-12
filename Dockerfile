# syntax=docker/dockerfile:1.7
# Orbit in one container: the server, headed Chromium agents on a virtual display, and a noVNC viewer
# for manual login. API keys are passed at run time (compose env_file) and never copied into the image.
ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    ORBIT_HOST=0.0.0.0 \
    PORT=4173 \
    ORBIT_WORKSPACES_DIR=/data/workspaces \
    ORBIT_BROWSER_CHANNEL=chromium \
    ORBIT_BLOCKED_PORTS=5900,6080 \
    DISPLAY=:99
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates fluxbox novnc tini websockify x11vnc xvfb \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
# Google Chrome has no Linux arm64 build: use the Chromium that matches the locked Playwright version.
# Call the CLI directly: pruning @playwright/test also removes the shared node_modules/.bin/playwright link.
RUN node node_modules/playwright/cli.js install --with-deps chromium \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data /tmp/.X11-unix \
  && chmod 1777 /tmp/.X11-unix \
  && chown node:node /data
COPY --from=build /app/dist ./dist
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/orbit-entrypoint
USER node
EXPOSE 4173 6080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4173) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "orbit-entrypoint"]
