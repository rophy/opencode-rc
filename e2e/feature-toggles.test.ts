import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { WebSocket } from "ws";
import { API_URL, SESSION_ID, waitFor, loginAs, upgradeStatus, type TokenSession } from "./helpers.js";

// Feature toggles are read by the API at startup, so the disabled case redeploys the API with
// a changed config (the chart's api-config ConfigMap) and restores it afterwards. The e2e
// vitest config runs test files one at a time, so no other file sees the restart. The UI
// image is built once with these features enabled; their UI patches are covered by the tests
// in ui/build/. Sharing is only tested disabled: enabled, it would publish the session.

const NAMESPACE = process.env.NAMESPACE ?? "default";
const CONFIG_MAP = "opencode-rc-api-config";

function kubectl(args: string[], timeoutMs = 60_000): string {
  return execFileSync("kubectl", ["-n", NAMESPACE, ...args], { encoding: "utf-8", timeout: timeoutMs }).trim();
}

// Redeploys the API with configJson and waits until it answers GET /pty/shells with the
// given status five times in a row: right after a rollout, the old pod can still serve
// requests while it shuts down.
async function redeployApi(configJson: string, jar: TokenSession, shellsStatus: number): Promise<void> {
  kubectl(["patch", "configmap", CONFIG_MAP, "--type", "merge", "-p", JSON.stringify({ data: { "config.json": configJson } })]);
  kubectl(["rollout", "restart", "deployment/opencode-rc-api"]);
  kubectl(["rollout", "status", "deployment/opencode-rc-api", "--timeout=180s"], 200_000);
  await waitFor("api", `${API_URL}/healthz`, 60);
  const deadline = Date.now() + 120_000;
  let streak = 0;
  while (streak < 5) {
    if (Date.now() > deadline) throw new Error(`API did not settle on GET /pty/shells ${shellsStatus}`);
    const res = await jar.fetch(`${API_URL}/proxy/${SESSION_ID}/pty/shells`).catch(() => undefined);
    streak = res?.status === shellsStatus ? streak + 1 : 0;
    await new Promise((r) => setTimeout(r, 500));
  }
}

describe("terminal enabled", () => {
  let jar: TokenSession;

  beforeAll(async () => {
    await waitFor("api", `${API_URL}/healthz`, 30);
    jar = await loginAs("user1");
  });

  it("echoes a command through web, gateway and tunnel", async () => {
    const created = await jar.fetch(`${API_URL}/proxy/${SESSION_ID}/pty`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(created.status).toBe(200);
    const pty = await created.json();
    expect(pty.id).toBeTruthy();

    const wsUrl =
      API_URL.replace(/^http/, "ws") +
      `/proxy/${SESSION_ID}/pty/${pty.id}/connect?cursor=0&access_token=${encodeURIComponent(jar.access)}`;
    const output = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";
      let text = "";
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`no echo within 15s, got: ${text.slice(-200)}`));
      }, 15_000);
      ws.onopen = () => ws.send("echo e2e-ws-$((40+2))\n");
      ws.onmessage = (e) => {
        text += typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data as ArrayBuffer);
        if (text.includes("e2e-ws-42")) {
          clearTimeout(timer);
          ws.close();
          resolve(text);
        }
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("websocket error"));
      };
    });
    expect(output).toContain("e2e-ws-42");
  });

  it("rejects a WebSocket without a token", async () => {
    // fetch() cannot send Upgrade/Connection headers, so attempt a real WebSocket.
    const failed = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(API_URL.replace(/^http/, "ws") + `/proxy/${SESSION_ID}/pty/x/connect`);
      ws.onopen = () => {
        ws.close();
        resolve(false);
      };
      ws.onerror = () => resolve(true);
    });
    expect(failed).toBe(true);
  });
});

describe("shell commands enabled", () => {
  it("runs a shell command in a session", async () => {
    const jar = await loginAs("user1");
    const json = { "content-type": "application/json" };
    const session = await (await jar.fetch(`${API_URL}/proxy/${SESSION_ID}/session`, { method: "POST", headers: json, body: "{}" })).json();
    const res = await jar.fetch(`${API_URL}/proxy/${SESSION_ID}/session/${session.id}/shell`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ agent: "build", command: "echo e2e-shell-$((40+2))" }),
    });
    expect(res.status).toBe(200);
  });
});

describe("terminal, shell commands and sharing disabled", () => {
  let jar: TokenSession;
  let original: string;

  beforeAll(async () => {
    jar = await loginAs("user1");
    original = kubectl(["get", "configmap", CONFIG_MAP, "-o", "jsonpath={.data.config\\.json}"]);
    const config = JSON.parse(original);
    const off = { enabled: false };
    const features = { ...config.features, terminal: off, shell: off, share: off };
    await redeployApi(JSON.stringify({ ...config, features }), jar, 403);
  }, 300_000);

  afterAll(async () => {
    await redeployApi(original, jar, 200);
  }, 300_000);

  it("refuses to create a terminal", async () => {
    const res = await jar.fetch(`${API_URL}/proxy/${SESSION_ID}/pty`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("the terminal is disabled");
  });

  it("refuses the terminal WebSocket, in the old and the new API", async () => {
    const ws = (path: string) =>
      upgradeStatus(API_URL.replace(/^http/, "ws") + `/proxy/${SESSION_ID}${path}?access_token=${encodeURIComponent(jar.access)}`);
    expect(await ws("/pty/x/connect")).toBe(403);
    expect(await ws("/api/pty/x/connect")).toBe(403);
  });

  it("refuses shell commands and sharing", async () => {
    const json = { "content-type": "application/json" };
    const session = await (await jar.fetch(`${API_URL}/proxy/${SESSION_ID}/session`, { method: "POST", headers: json, body: "{}" })).json();
    const shell = await jar.fetch(`${API_URL}/proxy/${SESSION_ID}/session/${session.id}/shell`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ agent: "build", command: "echo no" }),
    });
    expect(shell.status).toBe(403);
    expect(await shell.text()).toBe("shell commands are disabled");
    const share = await jar.fetch(`${API_URL}/proxy/${SESSION_ID}/session/${session.id}/share`, { method: "POST" });
    expect(share.status).toBe(403);
    expect(await share.text()).toBe("sharing is disabled");
  });

  it("still serves the rest of the session", async () => {
    expect((await jar.fetch(`${API_URL}/proxy/${SESSION_ID}/api/health`)).status).toBe(200);
  });
});
