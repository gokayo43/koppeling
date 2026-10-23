# The app is built INSIDE this image: `docker compose up -d` without a rebuild
# deploys nothing. Pinned by `bun run setup` to the Bun that produced bun.lock.
ARG BUN_VERSION=latest

FROM oven/bun:${BUN_VERSION} AS deps
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile
COPY . .

# `deps` is also the migration runner: it is the only stage that still carries
# drizzle-kit and the drizzle/ journal.
FROM deps AS build
RUN bun run build

FROM oven/bun:${BUN_VERSION} AS runtime
WORKDIR /app
# --chown so the unprivileged `bun` user can read the server bundle. Nitro
# bundles every server dependency into .output, so no install runs here.
COPY --from=build --chown=bun:bun /app/.output ./.output
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0
EXPOSE 3000
# PORT is above 1024, so nothing here needs root.
USER bun
CMD ["bun", ".output/server/index.mjs"]
