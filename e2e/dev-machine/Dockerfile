FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y curl git && rm -rf /var/lib/apt/lists/*

# Install opencode
RUN curl -fsSL https://opencode.ai/install | bash

ENV PATH="/root/.opencode/bin:${PATH}"

# Create a project directory for opencode to work in
WORKDIR /project
RUN git init && git config user.email "test@test.com" && git config user.name "Test"

# Configure opencode to use aimock as OpenAI provider
COPY opencode.json /project/opencode.json

EXPOSE 4096
CMD ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096", "--cors", "http://gateway:8080"]
