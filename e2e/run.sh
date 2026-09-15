#!/bin/bash
set -euo pipefail

# Run e2e tests against a kind cluster using the actual Helm chart.
#
# Usage: ./e2e/run.sh [--vitest] [--playwright] [--no-teardown]
#
# By default runs both vitest and playwright tests.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

CLUSTER_NAME="opencode-rc-e2e"
NAMESPACE="default"
RUN_VITEST=false
RUN_PLAYWRIGHT=false
TEARDOWN=true

for arg in "$@"; do
  case "$arg" in
    --vitest) RUN_VITEST=true ;;
    --playwright) RUN_PLAYWRIGHT=true ;;
    --no-teardown) TEARDOWN=false ;;
  esac
done

# Default: run both
if [ "$RUN_VITEST" = false ] && [ "$RUN_PLAYWRIGHT" = false ]; then
  RUN_VITEST=true
  RUN_PLAYWRIGHT=true
fi

cleanup() {
  if [ "$TEARDOWN" = true ]; then
    echo ""
    echo "=== Tearing down ==="
    skaffold delete -n "$NAMESPACE" 2>/dev/null || true
    kind delete cluster --name "$CLUSTER_NAME" 2>/dev/null || true
  else
    echo ""
    echo "=== Skipping teardown (--no-teardown) ==="
    echo "Cluster: $CLUSTER_NAME"
    echo "To tear down: kind delete cluster --name $CLUSTER_NAME"
  fi
}
trap cleanup EXIT

echo "=== Creating kind cluster ==="
if kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
  echo "Cluster $CLUSTER_NAME already exists"
  kubectl config use-context "kind-${CLUSTER_NAME}"
else
  kind create cluster --config kind-config.yaml
fi

echo ""
echo "=== Building and deploying ==="
skaffold run -n "$NAMESPACE"

echo ""
echo "=== Waiting for gateway to be healthy ==="
kubectl wait --for=condition=Available deployment/opencode-rc-gateway --timeout=120s -n "$NAMESPACE"

echo ""
echo "=== Waiting for dev-machine to be ready ==="
kubectl wait --for=condition=Available deployment/dev-machine --timeout=120s -n "$NAMESPACE"

DEV_POD=$(kubectl get pod -l app=dev-machine -o jsonpath='{.items[0].metadata.name}' -n "$NAMESPACE")

echo ""
echo "=== Waiting for tunnel to establish ==="
for i in $(seq 1 60); do
  if kubectl exec "$DEV_POD" -n "$NAMESPACE" -- curl -sf http://opencode-rc-gateway:8080/healthz >/dev/null 2>&1; then
    echo "Gateway reachable from dev-machine"
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "ERROR: gateway not reachable after 60 attempts"
    kubectl logs deployment/opencode-rc-gateway -n "$NAMESPACE" --tail=30
    kubectl logs deployment/dev-machine -n "$NAMESPACE" --tail=30
    exit 1
  fi
  sleep 2
done

TEST_EXIT=0

if [ "$RUN_VITEST" = true ]; then
  echo ""
  echo "=== Running vitest e2e tests ==="
  kubectl exec "$DEV_POD" -n "$NAMESPACE" -- sh -c \
    "cd /e2e && GATEWAY_URL=http://opencode-rc-gateway:8080 TUNNELER_URL=http://opencode-rc-tunneler:9090 OIDC_URL=http://opencode-rc-oidc-mock:8080 npx vitest run" || TEST_EXIT=$?
fi

if [ "$RUN_PLAYWRIGHT" = true ]; then
  echo ""
  echo "=== Running playwright e2e tests ==="
  kubectl exec "$DEV_POD" -n "$NAMESPACE" -- sh -c \
    "cd /e2e && GATEWAY_URL=http://opencode-rc-gateway:8080 npx playwright test --config playwright.config.ts" || TEST_EXIT=$?
fi

if [ "$TEST_EXIT" -ne 0 ]; then
  echo ""
  echo "=== Logs on failure ==="
  kubectl logs deployment/opencode-rc-gateway -n "$NAMESPACE" --tail=50 || true
  kubectl logs deployment/opencode-rc-tunneler -n "$NAMESPACE" --tail=50 || true
  kubectl logs deployment/dev-machine -n "$NAMESPACE" --tail=50 || true
fi

exit $TEST_EXIT
