FROM mcr.microsoft.com/playwright:v1.52.0-noble

RUN apt-get update && apt-get install -y curl git jq openssl && rm -rf /var/lib/apt/lists/*

# Install opencode
RUN curl -fsSL https://opencode.ai/install | bash
ENV PATH="/root/.opencode/bin:${PATH}"

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
COPY e2e/e2e.test.ts ./
COPY e2e/playwright/ ./playwright/

WORKDIR /project
ENTRYPOINT ["node", "/cli/dist/index.js"]
