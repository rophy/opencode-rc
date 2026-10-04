FROM oven/bun:1 AS build
WORKDIR /src
COPY vendor/opencode/package.json vendor/opencode/bun.lock vendor/opencode/
COPY vendor/opencode/patches/ vendor/opencode/patches/
COPY vendor/opencode/packages/ vendor/opencode/packages/
RUN cd vendor/opencode && bun install --frozen-lockfile --ignore-scripts
COPY ui/package.json ui/bun.lock ui/
RUN cd ui && bun install --frozen-lockfile
COPY config/ config/
COPY vendor/patches/ vendor/patches/
COPY ui/ ui/
# Path of the deployment's config.json inside the build context (e.g. --build-arg
# RC_CONFIG=deploy/config.json). Empty builds the generic image: users enter the server.
# The path must not be excluded by .dockerignore (it excludes docs/ and dist/); needs BuildKit.
ARG RC_CONFIG=""
RUN --mount=type=bind,target=/ctx \
    if [ -n "$RC_CONFIG" ]; then cp "/ctx/$RC_CONFIG" /src/rc-config.json; fi
RUN cd ui \
    && if [ -f /src/rc-config.json ]; then export OPENCODE_RC_CONFIG=/src/rc-config.json; fi \
    && OPENCODE_ROOT=/src/vendor/opencode bun run build \
    && bun run web/security-headers.ts > /src/security-headers.conf

FROM nginxinc/nginx-unprivileged:alpine
COPY ui/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/security-headers.conf /etc/nginx/rc/security-headers.conf
COPY --from=build /src/ui/dist /usr/share/nginx/html
EXPOSE 8080
