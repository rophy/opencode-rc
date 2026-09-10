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

FROM golang:1.25 AS gateway
WORKDIR /src
COPY gateway/go.mod gateway/go.sum ./
RUN go mod download
COPY gateway/*.go ./
COPY gateway/VERSION ./
RUN CGO_ENABLED=0 go build -ldflags "-X main.version=$(cat VERSION)" -o /gateway .

FROM gcr.io/distroless/static-debian12
COPY --from=gateway /gateway /gateway
COPY --from=web /src/web/dist /webui
ENV WEBUI_DIR=/webui
EXPOSE 8080
ENTRYPOINT ["/gateway"]
