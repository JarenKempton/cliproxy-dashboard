FROM oven/bun:1.4.0 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN bun install
COPY . .
RUN bun run build && rm -rf node_modules && bun install --production

FROM tailscale/tailscale:v1.102.5 AS tailscale

FROM oven/bun:1.4.0-slim
WORKDIR /app
COPY --from=tailscale /usr/local/bin/tailscale /usr/local/bin/tailscale
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/dist dist
COPY --from=build /app/package.json ./
COPY --from=build /app/server server
COPY --from=build /app/src/lib src/lib
CMD ["bun", "server/src/index.ts"]
