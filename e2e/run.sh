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
echo "=== Generating TLS test certs ==="
CERT_DIR=$(mktemp -d)
# CA 1 (trusted) + server cert for https-trusted service
openssl req -x509 -newkey rsa:2048 -keyout "$CERT_DIR/ca1.key" -out "$CERT_DIR/ca1.crt" \
  -days 1 -nodes -subj "/CN=Trusted CA" 2>/dev/null
openssl req -newkey rsa:2048 -keyout "$CERT_DIR/srv1.key" -out "$CERT_DIR/srv1.csr" \
  -nodes -subj "/CN=https-trusted" \
  -addext "subjectAltName=DNS:https-trusted,DNS:https-trusted.default.svc.cluster.local" 2>/dev/null
openssl x509 -req -in "$CERT_DIR/srv1.csr" -CA "$CERT_DIR/ca1.crt" -CAkey "$CERT_DIR/ca1.key" \
  -CAcreateserial -out "$CERT_DIR/srv1.crt" -days 1 \
  -copy_extensions copyall 2>/dev/null

# CA 2 (untrusted) + server cert for https-untrusted service
openssl req -x509 -newkey rsa:2048 -keyout "$CERT_DIR/ca2.key" -out "$CERT_DIR/ca2.crt" \
  -days 1 -nodes -subj "/CN=Untrusted CA" 2>/dev/null
openssl req -newkey rsa:2048 -keyout "$CERT_DIR/srv2.key" -out "$CERT_DIR/srv2.csr" \
  -nodes -subj "/CN=https-untrusted" \
  -addext "subjectAltName=DNS:https-untrusted,DNS:https-untrusted.default.svc.cluster.local" 2>/dev/null
openssl x509 -req -in "$CERT_DIR/srv2.csr" -CA "$CERT_DIR/ca2.crt" -CAkey "$CERT_DIR/ca2.key" \
  -CAcreateserial -out "$CERT_DIR/srv2.crt" -days 1 \
  -copy_extensions copyall 2>/dev/null

# Create k8s secrets for the TLS test
kubectl create secret tls tls-trusted \
  --cert="$CERT_DIR/srv1.crt" --key="$CERT_DIR/srv1.key" \
  -n "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
kubectl create secret tls tls-untrusted \
  --cert="$CERT_DIR/srv2.crt" --key="$CERT_DIR/srv2.key" \
  -n "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
kubectl create secret generic trusted-ca \
  --from-file=ca.crt="$CERT_DIR/ca1.crt" \
  -n "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
rm -rf "$CERT_DIR"

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

echo ""
echo "=== Testing SSL_CERT_DIR (TLS CA trust) ==="
# Wait for tls-test pods to attempt OIDC discovery (a few retries)
echo "Waiting for TLS test pods to produce logs..."
sleep 15

TLS_EXIT=0

# Trusted pod: CA is in SSL_CERT_DIR, should NOT get x509 error
# It should fail with OIDC discovery error (404 from nginx, not valid OIDC)
TRUSTED_LOGS=$(kubectl logs deployment/tls-test-trusted -n "$NAMESPACE" --tail=30 2>&1) || true
if echo "$TRUSTED_LOGS" | grep -qi "x509"; then
  echo "FAIL: trusted endpoint got x509 error (SSL_CERT_DIR not working)"
  echo "$TRUSTED_LOGS"
  TLS_EXIT=1
else
  echo "PASS: trusted endpoint - no x509 error (TLS handshake succeeded)"
fi

# Untrusted pod: CA is NOT in SSL_CERT_DIR, SHOULD get x509 error
UNTRUSTED_LOGS=$(kubectl logs deployment/tls-test-untrusted -n "$NAMESPACE" --tail=30 2>&1) || true
if echo "$UNTRUSTED_LOGS" | grep -qi "x509"; then
  echo "PASS: untrusted endpoint - got x509 error as expected"
else
  echo "FAIL: untrusted endpoint did not get x509 error"
  echo "$UNTRUSTED_LOGS"
  TLS_EXIT=1
fi

if [ "$TLS_EXIT" -ne 0 ]; then
  echo ""
  echo "=== TLS test FAILED ==="
  exit 1
fi

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
