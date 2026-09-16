FROM golang:1.25 AS build
WORKDIR /src
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/*.go ./
COPY backend/VERSION ./
ARG COVER=false
RUN if [ "$COVER" = "true" ]; then \
      CGO_ENABLED=0 go build -cover -covermode=atomic -ldflags "-X main.version=$(cat VERSION)" -o /opencode-rc .; \
    else \
      CGO_ENABLED=0 go build -ldflags "-X main.version=$(cat VERSION)" -o /opencode-rc .; \
    fi

FROM gcr.io/distroless/static-debian12
COPY --from=build /opencode-rc /opencode-rc
EXPOSE 8080
ENTRYPOINT ["/opencode-rc", "tunneler"]
