FROM oven/bun:1 AS web
WORKDIR /src
COPY vendor/opencode/package.json vendor/opencode/bun.lock vendor/opencode/
COPY vendor/opencode/patches/ vendor/opencode/patches/
COPY vendor/opencode/packages/ vendor/opencode/packages/
RUN cd vendor/opencode && bun install --frozen-lockfile --ignore-scripts
COPY web/package.json web/bun.lock web/
RUN cd web && bun install --frozen-lockfile
COPY web/ web/
RUN cd web && OPENCODE_ROOT=/src/vendor/opencode bun run build

FROM golang:1.25 AS backend
WORKDIR /src
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/*.go ./
COPY backend/VERSION ./
ARG COVER=false
RUN if [ "$COVER" = "true" ]; then \
      CGO_ENABLED=0 go build -cover -ldflags "-X main.version=$(cat VERSION)" -o /opencode-rc .; \
    else \
      CGO_ENABLED=0 go build -ldflags "-X main.version=$(cat VERSION)" -o /opencode-rc .; \
    fi

FROM gcr.io/distroless/static-debian12
COPY --from=backend /opencode-rc /opencode-rc
COPY --from=web /src/web/dist /webui
ENV WEBUI_DIR=/webui
EXPOSE 8080
ENTRYPOINT ["/opencode-rc"]
