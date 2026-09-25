import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "child_process";

const NAMESPACE = process.env.NAMESPACE ?? "default";

function kubectl(args: string, timeoutMs = 30_000): string {
  return execSync(`kubectl -n ${NAMESPACE} ${args}`, {
    encoding: "utf-8",
    timeout: timeoutMs,
  }).trim();
}

function kubectlSafe(args: string): string {
  try {
    return kubectl(args);
  } catch {
    return "";
  }
}

function waitForDeployment(name: string, timeoutSec = 60): void {
  // The process timeout must outlast kubectl's own wait, or slow image pulls kill it early.
  kubectl(
    `wait --for=condition=Available deployment/${name} --timeout=${timeoutSec}s`,
    (timeoutSec + 15) * 1000
  );
}

function waitForLogs(
  deployment: string,
  pattern: RegExp,
  timeoutSec = 90
): string {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    const logs = kubectlSafe(`logs deployment/${deployment} --tail=50`);
    if (pattern.test(logs)) return logs;
    execSync("sleep 2");
  }
  throw new Error(
    `Timed out waiting for ${deployment} logs matching ${pattern}`
  );
}

describe("extraCACerts TLS CA trust", () => {
  let gatewayImage: string;
  let apiImage: string;

  beforeAll(() => {
    // Discover the image tags skaffold assigned to gateway and web
    gatewayImage = kubectl(
      "get deploy opencode-rc-gateway -o jsonpath={.spec.template.spec.containers[0].image}"
    );
    apiImage = kubectl(
      "get deploy opencode-rc-api -o jsonpath={.spec.template.spec.containers[0].image}"
    );

    // Generate CA certs
    execSync(`set -e
      CERT_DIR=$(mktemp -d)
      # CA 1 (trusted) + server cert
      openssl req -x509 -newkey rsa:2048 -keyout $CERT_DIR/ca1.key -out $CERT_DIR/ca1.crt \
        -days 1 -nodes -subj "/CN=Trusted CA" 2>/dev/null
      openssl req -newkey rsa:2048 -keyout $CERT_DIR/srv1.key -out $CERT_DIR/srv1.csr \
        -nodes -subj "/CN=https-trusted" \
        -addext "subjectAltName=DNS:https-trusted,DNS:https-trusted.${NAMESPACE}.svc.cluster.local" 2>/dev/null
      openssl x509 -req -in $CERT_DIR/srv1.csr -CA $CERT_DIR/ca1.crt -CAkey $CERT_DIR/ca1.key \
        -CAcreateserial -out $CERT_DIR/srv1.crt -days 1 -copy_extensions copyall 2>/dev/null

      # CA 2 (untrusted) + server cert
      openssl req -x509 -newkey rsa:2048 -keyout $CERT_DIR/ca2.key -out $CERT_DIR/ca2.crt \
        -days 1 -nodes -subj "/CN=Untrusted CA" 2>/dev/null
      openssl req -newkey rsa:2048 -keyout $CERT_DIR/srv2.key -out $CERT_DIR/srv2.csr \
        -nodes -subj "/CN=https-untrusted" \
        -addext "subjectAltName=DNS:https-untrusted,DNS:https-untrusted.${NAMESPACE}.svc.cluster.local" 2>/dev/null
      openssl x509 -req -in $CERT_DIR/srv2.csr -CA $CERT_DIR/ca2.crt -CAkey $CERT_DIR/ca2.key \
        -CAcreateserial -out $CERT_DIR/srv2.crt -days 1 -copy_extensions copyall 2>/dev/null

      # Create k8s secrets
      kubectl -n ${NAMESPACE} create secret tls tls-trusted \
        --cert=$CERT_DIR/srv1.crt --key=$CERT_DIR/srv1.key \
        --dry-run=client -o yaml | kubectl -n ${NAMESPACE} apply -f -
      kubectl -n ${NAMESPACE} create secret tls tls-untrusted \
        --cert=$CERT_DIR/srv2.crt --key=$CERT_DIR/srv2.key \
        --dry-run=client -o yaml | kubectl -n ${NAMESPACE} apply -f -
      kubectl -n ${NAMESPACE} create secret generic trusted-ca \
        --from-file=ca.crt=$CERT_DIR/ca1.crt \
        --dry-run=client -o yaml | kubectl -n ${NAMESPACE} apply -f -
      rm -rf $CERT_DIR
    `, { shell: "/bin/bash", timeout: 30_000 });

    // Deploy HTTPS servers and test pods
    kubectl("apply -f /e2e/k8s/tls-test.yaml");

    // Create test pods with the actual skaffold-built images
    const testPods = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: tls-test-trusted
  labels:
    tls-test: "true"
spec:
  replicas: 1
  selector:
    matchLabels:
      app: tls-test-trusted
  template:
    metadata:
      labels:
        app: tls-test-trusted
    spec:
      containers:
        - name: gateway
          image: ${gatewayImage}
          env:
            - name: OIDC_ISSUER
              value: "https://https-trusted"
            - name: OIDC_CLIENT_ID
              value: "test"
            - name: OIDC_REDIRECT_URI
              value: "http://localhost/callback"
            - name: TOKEN_SECRET
              value: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
            - name: REDIS_URL
              value: "redis://opencode-rc-redis:6379/1"
            - name: POD_IP
              valueFrom:
                fieldRef:
                  fieldPath: status.podIP
            - name: SSL_CERT_FILE
              value: "/etc/ssl/certs/extra/ca-bundle.crt"
          volumeMounts:
            - name: trusted-ca
              mountPath: /etc/ssl/certs/extra/ca-bundle.crt
              subPath: ca.crt
              readOnly: true
      volumes:
        - name: trusted-ca
          secret:
            secretName: trusted-ca
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: tls-test-web-trusted
  labels:
    tls-test: "true"
spec:
  replicas: 1
  selector:
    matchLabels:
      app: tls-test-web-trusted
  template:
    metadata:
      labels:
        app: tls-test-web-trusted
    spec:
      containers:
        - name: web
          image: ${apiImage}
          env:
            - name: OIDC_ISSUER
              value: "https://https-trusted"
            - name: OIDC_CLIENT_ID
              value: "test"
            - name: OIDC_CLIENT_SECRET
              value: "test"
            - name: OIDC_REDIRECT_URI
              value: "http://localhost/callback"
            - name: TOKEN_SECRET
              value: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
            - name: REDIS_URL
              value: "redis://opencode-rc-redis:6379/2"
            - name: NODE_EXTRA_CA_CERTS
              value: "/etc/ssl/certs/extra/ca-bundle.crt"
          volumeMounts:
            - name: trusted-ca
              mountPath: /etc/ssl/certs/extra/ca-bundle.crt
              subPath: ca.crt
              readOnly: true
      volumes:
        - name: trusted-ca
          secret:
            secretName: trusted-ca
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: tls-test-untrusted
  labels:
    tls-test: "true"
spec:
  replicas: 1
  selector:
    matchLabels:
      app: tls-test-untrusted
  template:
    metadata:
      labels:
        app: tls-test-untrusted
    spec:
      containers:
        - name: gateway
          image: ${gatewayImage}
          env:
            - name: OIDC_ISSUER
              value: "https://https-untrusted"
            - name: OIDC_CLIENT_ID
              value: "test"
            - name: OIDC_REDIRECT_URI
              value: "http://localhost/callback"
            - name: TOKEN_SECRET
              value: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
            - name: REDIS_URL
              value: "redis://opencode-rc-redis:6379/1"
            - name: POD_IP
              valueFrom:
                fieldRef:
                  fieldPath: status.podIP
`;
    execSync(`echo '${testPods.replace(/'/g, "'\\''")}' | kubectl -n ${NAMESPACE} apply -f -`, {
      shell: "/bin/bash",
      timeout: 30_000,
    });

    // Wait for HTTPS servers
    waitForDeployment("https-trusted");
    waitForDeployment("https-untrusted");
  }, 120_000);

  afterAll(() => {
    // Clean up test resources
    kubectlSafe("delete deploy -l tls-test=true");
    kubectlSafe("delete deploy https-trusted https-untrusted");
    kubectlSafe("delete svc https-trusted https-untrusted");
    kubectlSafe("delete configmap nginx-https-conf");
    kubectlSafe("delete secret tls-trusted tls-untrusted trusted-ca");
  });

  it("gateway with SSL_CERT_FILE trusts private CA", () => {
    const logs = waitForLogs("tls-test-trusted", /connected to Redis|gateway starting/i);
    expect(logs).not.toMatch(/x509|unable to verify|self.signed/i);
  });

  it("api with NODE_EXTRA_CA_CERTS trusts private CA", () => {
    const logs = waitForLogs("tls-test-web-trusted", /OIDC discovery complete|api starting/i);
    expect(logs).not.toMatch(
      /x509|unable to verify|self.signed|UNABLE_TO_VERIFY/i
    );
  });

  it("gateway without CA cert gets TLS error", () => {
    const logs = waitForLogs(
      "tls-test-untrusted",
      /x509|unable to verify|self.signed|certificate/i
    );
    expect(logs).toMatch(/x509|unable to verify|self.signed/i);
  });
});
