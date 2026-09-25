FROM oven/bun:1-slim
WORKDIR /app
COPY api/package.json api/bun.lock* ./
RUN bun install --production --frozen-lockfile 2>/dev/null || bun install --production
COPY api/src/ src/
EXPOSE 8080
CMD ["bun", "run", "src/index.ts"]
