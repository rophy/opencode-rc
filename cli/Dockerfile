FROM mcr.microsoft.com/playwright:v1.52.0-noble

# Pinned, checksum-verified downloads (no remote install scripts). opencode matches
# the vendor/opencode tag the UI is built from. Bump versions and checksums together.
ARG TARGETARCH
ARG KUBECTL_VERSION=v1.37.1
ARG KUBECTL_SHA256_AMD64=65691ff77eb6fa44c908b77a1082c9f092c3b9733b5cefabec0d1104890e21a8
ARG KUBECTL_SHA256_ARM64=ff749f4b78d9c4f1ec87307df9b50119ed819e2094aa9810cb9acffc3286c8c7
ARG OPENCODE_VERSION=1.18.29
ARG OPENCODE_SHA256_AMD64=ea800b7ff56226b70952126c9fc1e2517ca4c4b5682fd9d3f9e87449697a1194
ARG OPENCODE_SHA256_ARM64=70baf769395ca4e7a68924026530c390eace194f3b7e4919d4efcb2aa2eed3c0
# -C - resumes a partial download on retry (GitHub release downloads can be slow).
ARG CURL="curl -fsSL -C - --retry 10 --retry-all-errors --connect-timeout 20 --max-time 900"

RUN apt-get update && apt-get install -y curl git jq openssl && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "$arch" in \
      amd64) k_sha="$KUBECTL_SHA256_AMD64"; o_arch=x64; o_sha="$OPENCODE_SHA256_AMD64" ;; \
      arm64) k_sha="$KUBECTL_SHA256_ARM64"; o_arch=arm64; o_sha="$OPENCODE_SHA256_ARM64" ;; \
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    $CURL -o /usr/local/bin/kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${arch}/kubectl"; \
    echo "${k_sha}  /usr/local/bin/kubectl" | sha256sum -c -; \
    chmod +x /usr/local/bin/kubectl; \
    $CURL -o /tmp/opencode.tar.gz "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-${o_arch}.tar.gz"; \
    echo "${o_sha}  /tmp/opencode.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/opencode.tar.gz -C /usr/local/bin opencode; \
    rm /tmp/opencode.tar.gz; \
    opencode --version

# Create a project directory for opencode to work in
WORKDIR /project
RUN git init && git config user.email "test@test.com" && git config user.name "Test"

# Build CLI
WORKDIR /cli
COPY cli/package.json cli/package-lock.json ./
RUN npm install
COPY cli/tsconfig.json ./
COPY cli/src/ ./src/
RUN npx tsc

# Install e2e deps (vitest + playwright)
WORKDIR /e2e
COPY e2e/package.json e2e/package-lock.json ./
RUN npm install
COPY e2e/tsconfig.json e2e/vitest.config.ts e2e/playwright.config.ts ./
COPY e2e/*.test.ts ./
COPY e2e/playwright/ ./playwright/
COPY e2e/k8s/ ./k8s/

WORKDIR /project
ENTRYPOINT ["node", "/cli/dist/index.js"]
