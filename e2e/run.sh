#!/bin/bash
set -euo pipefail

# CI wrapper: brings up the cluster, runs tests, and tears down.
# For iterative development, use make targets directly:
#   make up        — create cluster and deploy
#   make e2e-test  — run tests with coverage
#   make down      — tear down cluster

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

trap 'make down' EXIT
make up
make e2e-test
