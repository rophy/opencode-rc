#!/bin/bash
set -euo pipefail

# Collect e2e test coverage from the kind cluster.
# Builds with -cover, deploys, runs tests, collects coverage via HTTP, generates report.
#
# Usage: ./e2e/coverage.sh [--no-teardown]
#
# Prerequisites: kind cluster running with TLS certs (run ./e2e/run.sh --no-teardown first,
# or this script will create everything from scratch).

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SCRIPT_DIR"

CLUSTER_NAME="opencode-rc-e2e"
NAMESPACE="default"
COVER_DIR="$REPO_ROOT/.cover"
TEARDOWN=true

for arg in "$@"; do
  case "$arg" in
    --no-teardown) TEARDOWN=false ;;
  esac
done

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
  fi
}
trap cleanup EXIT

# Create kind cluster if needed
echo "=== Creating kind cluster ==="
if kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
  echo "Cluster $CLUSTER_NAME already exists"
  kubectl config use-context "kind-${CLUSTER_NAME}"
else
  kind create cluster --config kind-config.yaml
fi

# Generate TLS certs if secrets don't exist
if ! kubectl get secret tls-trusted -n "$NAMESPACE" >/dev/null 2>&1; then
  echo ""
  echo "=== Generating TLS test certs ==="
  CERT_DIR=$(mktemp -d)
  openssl req -x509 -newkey rsa:2048 -keyout "$CERT_DIR/ca1.key" -out "$CERT_DIR/ca1.crt" \
    -days 1 -nodes -subj "/CN=Trusted CA" 2>/dev/null
  openssl req -newkey rsa:2048 -keyout "$CERT_DIR/srv1.key" -out "$CERT_DIR/srv1.csr" \
    -nodes -subj "/CN=https-trusted" \
    -addext "subjectAltName=DNS:https-trusted,DNS:https-trusted.default.svc.cluster.local" 2>/dev/null
  openssl x509 -req -in "$CERT_DIR/srv1.csr" -CA "$CERT_DIR/ca1.crt" -CAkey "$CERT_DIR/ca1.key" \
    -CAcreateserial -out "$CERT_DIR/srv1.crt" -days 1 -copy_extensions copyall 2>/dev/null

  openssl req -x509 -newkey rsa:2048 -keyout "$CERT_DIR/ca2.key" -out "$CERT_DIR/ca2.crt" \
    -days 1 -nodes -subj "/CN=Untrusted CA" 2>/dev/null
  openssl req -newkey rsa:2048 -keyout "$CERT_DIR/srv2.key" -out "$CERT_DIR/srv2.csr" \
    -nodes -subj "/CN=https-untrusted" \
    -addext "subjectAltName=DNS:https-untrusted,DNS:https-untrusted.default.svc.cluster.local" 2>/dev/null
  openssl x509 -req -in "$CERT_DIR/srv2.csr" -CA "$CERT_DIR/ca2.crt" -CAkey "$CERT_DIR/ca2.key" \
    -CAcreateserial -out "$CERT_DIR/srv2.crt" -days 1 -copy_extensions copyall 2>/dev/null

  kubectl create secret tls tls-trusted --cert="$CERT_DIR/srv1.crt" --key="$CERT_DIR/srv1.key" \
    -n "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
  kubectl create secret tls tls-untrusted --cert="$CERT_DIR/srv2.crt" --key="$CERT_DIR/srv2.key" \
    -n "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
  kubectl create secret generic trusted-ca --from-file=ca.crt="$CERT_DIR/ca1.crt" \
    -n "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
  rm -rf "$CERT_DIR"
fi

echo ""
echo "=== Building with coverage and deploying ==="
skaffold run -n "$NAMESPACE"

echo ""
echo "=== Waiting for gateway ==="
kubectl wait --for=condition=Available deployment/opencode-rc-gateway --timeout=120s -n "$NAMESPACE"

echo ""
echo "=== Waiting for dev-machine ==="
kubectl wait --for=condition=Available deployment/dev-machine --timeout=120s -n "$NAMESPACE"

DEV_POD=$(kubectl get pod -l app=dev-machine -o jsonpath='{.items[0].metadata.name}' -n "$NAMESPACE")

echo ""
echo "=== Waiting for tunnel ==="
for i in $(seq 1 60); do
  if kubectl exec "$DEV_POD" -n "$NAMESPACE" -- curl -sf http://opencode-rc-gateway:8080/healthz >/dev/null 2>&1; then
    echo "Gateway reachable from dev-machine"
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "ERROR: gateway not reachable after 60 attempts"
    exit 1
  fi
  sleep 2
done

echo ""
echo "=== Running vitest e2e tests ==="
kubectl exec "$DEV_POD" -n "$NAMESPACE" -- sh -c \
  "cd /e2e && GATEWAY_URL=http://opencode-rc-gateway:8080 TUNNELER_URL=http://opencode-rc-tunneler:9090 OIDC_URL=http://opencode-rc-oidc-mock:8080 npx vitest run" || true

echo ""
echo "=== Running playwright e2e tests ==="
kubectl exec "$DEV_POD" -n "$NAMESPACE" -- sh -c \
  "cd /e2e && GATEWAY_URL=http://opencode-rc-gateway:8080 npx playwright test --config playwright.config.ts" || true

echo ""
echo "=== Collecting coverage ==="
rm -rf "$COVER_DIR"
mkdir -p "$COVER_DIR/raw"

# Collect from gateway
kubectl exec "$DEV_POD" -n "$NAMESPACE" -- \
  curl -sf http://opencode-rc-gateway:8080/debug/coverage > "$COVER_DIR/raw/gateway.tar"
if [ -s "$COVER_DIR/raw/gateway.tar" ]; then
  mkdir -p "$COVER_DIR/raw/gateway"
  tar xf "$COVER_DIR/raw/gateway.tar" -C "$COVER_DIR/raw/gateway"
  echo "Gateway coverage collected"
else
  echo "WARNING: No gateway coverage (not built with -cover?)"
fi

# Collect from tunneler
kubectl exec "$DEV_POD" -n "$NAMESPACE" -- \
  curl -sf http://opencode-rc-tunneler:9090/debug/coverage > "$COVER_DIR/raw/tunneler.tar"
if [ -s "$COVER_DIR/raw/tunneler.tar" ]; then
  mkdir -p "$COVER_DIR/raw/tunneler"
  tar xf "$COVER_DIR/raw/tunneler.tar" -C "$COVER_DIR/raw/tunneler"
  echo "Tunneler coverage collected"
else
  echo "WARNING: No tunneler coverage (not built with -cover?)"
fi

echo ""
echo "=== Merging coverage ==="
mkdir -p "$COVER_DIR/merged"
go tool covdata merge -i="$COVER_DIR/raw/gateway","$COVER_DIR/raw/tunneler" -o="$COVER_DIR/merged"

echo ""
echo "=== Generating report ==="
cd "$REPO_ROOT/backend"
go tool covdata textfmt -i="$COVER_DIR/merged" -o="$COVER_DIR/coverage.out"
go tool cover -func="$COVER_DIR/coverage.out" | tail -1
go tool cover -html="$COVER_DIR/coverage.out" -o="$COVER_DIR/coverage.html"

echo ""
echo "Coverage report: $COVER_DIR/coverage.html"
echo "Coverage data:   $COVER_DIR/coverage.out"
