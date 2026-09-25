#!/bin/bash
set -euo pipefail

# CI-style wrapper: deploys into a namespace on an existing cluster, runs tests, and tears down.
# It never creates or deletes clusters. For iterative development, use make targets directly:
#   make up        — create the namespace and deploy
#   make e2e-test  — run tests with coverage
#   make down      — delete the namespace (only if `make up` created it)
#
# KUBE_CONTEXT defaults to the current kubectl context; NAMESPACE defaults to opencode-rc.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Resolve the context once so a context switch mid-run cannot redirect teardown.
KUBE_CONTEXT="${KUBE_CONTEXT:-$(kubectl config current-context 2>/dev/null || true)}"
export KUBE_CONTEXT

trap 'make down' EXIT
make up
make e2e-test
