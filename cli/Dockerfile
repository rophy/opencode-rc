FROM node:22-slim

RUN apt-get update && apt-get install -y curl git jq openssl && rm -rf /var/lib/apt/lists/*

# Install opencode
RUN curl -fsSL https://opencode.ai/install | bash
ENV PATH="/root/.opencode/bin:${PATH}"

# Create a project directory for opencode to work in
WORKDIR /project
RUN git init && git config user.email "test@test.com" && git config user.name "Test"

# Build CLI
WORKDIR /cli
COPY package.json package-lock.json ./
RUN npm install
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

WORKDIR /project
ENTRYPOINT ["node", "/cli/dist/index.js"]
