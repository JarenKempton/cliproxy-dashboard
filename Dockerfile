FROM oven/bun:1.4.0 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN bun install
COPY . .
RUN bun run build && rm -rf node_modules && bun install --production \
 && rm -rf node_modules/onnxruntime-web node_modules/onnxruntime-node/bin/napi-v*/darwin node_modules/onnxruntime-node/bin/napi-v*/win32 \
      node_modules/onnxruntime-node/bin/napi-v*/linux/*/libonnxruntime_providers_cuda.so \
      node_modules/onnxruntime-node/bin/napi-v*/linux/*/libonnxruntime_providers_tensorrt.so \
 && HISTORY_MODEL_DIR=/app/models bun server/src/history/embed.ts

# Quench nightly 0.1.0-nightly.26, the first with `runs --all --history` (quench#109).
# The nightly release is replaced on every quench merge, so it is rebuilt here
# from its commit with the same command and version stamp as quench's release workflow.
FROM oven/bun:1.4.2 AS quench
ARG QUENCH_COMMIT=b849df0b4f363f72ee45619351f90d0d4c61f677
ARG QUENCH_VERSION=0.1.0-nightly.26
ADD https://github.com/JarenKempton/quench.git#${QUENCH_COMMIT} /quench
WORKDIR /quench
RUN bun install --frozen-lockfile \
 && bun build --compile --define "process.env.QUENCH_VERSION=\"$QUENCH_VERSION\"" packages/cli/src/main.ts --outfile /usr/local/bin/quench \
 && test "$(quench --version)" = "quench $QUENCH_VERSION"

FROM tailscale/tailscale:v1.102.5 AS tailscale

FROM oven/bun:1.4.0-slim
WORKDIR /app
COPY --from=tailscale /usr/local/bin/tailscale /usr/local/bin/tailscale
COPY --from=quench /usr/local/bin/quench /usr/local/bin/quench
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/models models
COPY --from=build /app/dist dist
COPY --from=build /app/package.json ./
COPY --from=build /app/server server
COPY --from=build /app/src/lib src/lib
CMD ["bun", "server/src/index.ts"]
