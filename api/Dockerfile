FROM oven/bun:1 AS ui
WORKDIR /src
COPY vendor/opencode/package.json vendor/opencode/bun.lock vendor/opencode/
COPY vendor/opencode/patches/ vendor/opencode/patches/
COPY vendor/opencode/packages/ vendor/opencode/packages/
RUN cd vendor/opencode && bun install --frozen-lockfile --ignore-scripts
COPY ui/package.json ui/bun.lock ui/
RUN cd ui && bun install --frozen-lockfile
COPY ui/ ui/
RUN cd ui && OPENCODE_ROOT=/src/vendor/opencode bun run build

FROM oven/bun:1-slim
WORKDIR /app
COPY api/package.json api/bun.lock* ./
RUN bun install --production --frozen-lockfile 2>/dev/null || bun install --production
COPY api/src/ src/
COPY --from=ui /src/ui/dist /webui
ENV WEBUI_DIR=/webui
EXPOSE 8080
CMD ["bun", "run", "src/index.ts"]
