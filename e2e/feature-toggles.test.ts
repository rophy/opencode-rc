import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { API_URL, SESSION_ID, SESSION_ID_V2, waitFor, loginAs, upgradeStatus, type TokenSession } from "./helpers.js";

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
    const opencodeV2 = { ...config.opencodeV2, features: { ...config.opencodeV2?.features, terminal: off, shell: off } };
    await redeployApi(JSON.stringify({ ...config, features, opencodeV2 }), jar, 403);
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

  it("refuses to create a terminal on the opencode 2.x machine", async () => {
    const res = await jar.fetch(`${API_URL}/proxy/${SESSION_ID_V2}/api/pty`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(400);
    expect((await res.json())._tag).toBe("FeatureDisabled");
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

  // opencode runs !`cmd` in a command's text after adding the arguments to the template; the
  // built-in init command exists on both machines.
  it("refuses shell interpolation in command arguments", async () => {
    const json = { "content-type": "application/json" };
    const session = await (await jar.fetch(`${API_URL}/proxy/${SESSION_ID}/session`, { method: "POST", headers: json, body: "{}" })).json();
    const command = (args: string) =>
      jar.fetch(`${API_URL}/proxy/${SESSION_ID}/session/${session.id}/command`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ command: "init", arguments: args, parts: [] }),
      });
    const refused = await command("!`echo pwned`");
    expect(refused.status).toBe(403);
    expect(await refused.text()).toBe("shell commands are disabled");
    // Positive control: without !` the guard forwards it (opencode runs init against the mock AI).
    expect((await command("wow!")).status).not.toBe(403);
  }, 60_000);

  it("refuses shell interpolation in command text on the opencode 2.x machine", async () => {
    const json = { "content-type": "application/json" };
    const created = await jar.fetch(`${API_URL}/proxy/${SESSION_ID_V2}/api/session`, { method: "POST", headers: json, body: "{}" });
    expect(created.status).toBe(200);
    const id = (await created.json()).data.id;
    const command = (text: string) =>
      jar.fetch(`${API_URL}/proxy/${SESSION_ID_V2}/api/session/${id}/command`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ name: "init", text }),
      });
    const refused = await command("!`echo pwned`");
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ _tag: "FeatureDisabled", message: "shell commands are disabled" });
    // Positive control: without !` the guard forwards it; a guard refusal would be a FeatureDisabled 400.
    const passed = await command("wow!");
    const body = await passed.text();
    expect(body).not.toContain("FeatureDisabled");
  }, 60_000);

  it("still serves the rest of the session", async () => {
    expect((await jar.fetch(`${API_URL}/proxy/${SESSION_ID}/api/health`)).status).toBe(200);
  });
});

describe("opencode 2.x uploads enabled", () => {
  let jar: TokenSession;
  let original: string;
  const V2 = `${API_URL}/proxy/${SESSION_ID_V2}`;
  const write = (path: string) =>
    jar.fetch(`${V2}/api/experimental/fs/write?path=${encodeURIComponent(path)}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: "e2e upload",
    });

  beforeAll(async () => {
    jar = await loginAs("user1");
    original = kubectl(["get", "configmap", CONFIG_MAP, "-o", "jsonpath={.data.config\\.json}"]);
    const config = JSON.parse(original);
    const opencodeV2 = {
      ...config.opencodeV2,
      features: { ...config.opencodeV2?.features, uploads: { enabled: true } },
    };
    // The terminal is still enabled here, so GET /pty/shells answers 200 on the 1.x machine.
    await redeployApi(JSON.stringify({ ...config, opencodeV2 }), jar, 200);
  }, 300_000);

  afterAll(async () => {
    if (original) await redeployApi(original, jar, 200);
  }, 300_000);

  it("writes inside the server's uploads folder and refuses other paths", async () => {
    let info: any;
    for (let i = 0; i < 30; i++) {
      const res = await jar.fetch(`${V2}/api/info`).catch(() => undefined);
      if (res?.status === 200) {
        info = await res.json();
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    const tmp: string | undefined = (info?.data ?? info)?.paths?.tmp;
    expect(tmp).toBeTruthy();

    // redeployApi's probe answers 200 under the old and the new config, so the old API pod (uploads
    // disabled) may still serve the first writes: wait for several consecutive 200s.
    const deadline = Date.now() + 60_000;
    let streak = 0;
    let last = "no response";
    while (streak < 3) {
      if (Date.now() > deadline) throw new Error(`uploads write never settled on 200, last: ${last}`);
      const res = await write(`${tmp!.replace(/\/$/, "")}/uploads/${randomUUID()}/e2e.txt`).catch(() => undefined);
      if (res?.status === 200) streak++;
      else {
        streak = 0;
        last = res ? `${res.status} ${await res.text()}` : "request failed";
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    const outside = await write("/tmp/e2e-outside.txt");
    expect(outside.status).toBe(400);
    const body = await outside.json();
    expect(body._tag).toBe("FeatureDisabled");
    expect(body.message).toContain("only be written");
  });
});
