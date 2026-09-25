FROM oven/bun:1 AS build
WORKDIR /src
COPY vendor/opencode/package.json vendor/opencode/bun.lock vendor/opencode/
COPY vendor/opencode/patches/ vendor/opencode/patches/
COPY vendor/opencode/packages/ vendor/opencode/packages/
RUN cd vendor/opencode && bun install --frozen-lockfile --ignore-scripts
COPY ui/package.json ui/bun.lock ui/
RUN cd ui && bun install --frozen-lockfile
COPY ui/ ui/
RUN cd ui && OPENCODE_ROOT=/src/vendor/opencode bun run build

FROM nginxinc/nginx-unprivileged:alpine
COPY ui/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --chmod=0755 ui/web/40-rc-config.sh /docker-entrypoint.d/40-rc-config.sh
COPY --from=build /src/ui/dist /usr/share/nginx/html
EXPOSE 8080
