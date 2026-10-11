import { describe, it, expect, beforeAll } from "vitest";
import { WebSocket } from "ws";
import { API_URL, OPENCODE_V2_VERSION, SESSION_ID, SESSION_ID_V2, waitFor, loginAs, type TokenSession } from "./helpers.js";

// API and tunnel tests against the second dev machine, which runs opencode 2.x. The API
// config disables 2.x uploads and leaves the terminal on (e2e/values.yaml); the 2.x terminal
// being disabled is tested in feature-toggles.test.ts, which redeploys the API.

const V2 = `${API_URL}/proxy/${SESSION_ID_V2}`;
const JSON_HEADERS = { "content-type": "application/json" };

describe("opencode 2.x dev machine", () => {
  let jar: TokenSession;

  beforeAll(async () => {
    await waitFor("api", `${API_URL}/healthz`, 30);
    jar = await loginAs("user1");
    // Both dev machines register after the API is up; wait until the gateway lists them.
    const deadline = Date.now() + 120_000;
    for (;;) {
      const res = await jar.fetch(`${API_URL}/gateway/sessions`).catch(() => undefined);
      const sessions: any[] = res?.status === 200 ? await res.json().catch(() => []) : [];
      if ([SESSION_ID, SESSION_ID_V2].every((id) => sessions.some((s) => s.id === id))) break;
      if (Date.now() > deadline) throw new Error("dev machines not both registered after 120s");
      await new Promise((r) => setTimeout(r, 1000));
    }
  }, 150_000);

  async function featureDisabled(res: Response): Promise<void> {
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body._tag).toBe("FeatureDisabled");
  }

  // Retries while the machine finishes registering.
  async function getInfo(): Promise<Response> {
    let res!: Response;
    for (let i = 0; i < 30; i++) {
      res = await jar.fetch(`${V2}/api/info`).catch(() => undefined as unknown as Response);
      if (res?.status === 200) return res;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return res;
  }

  it("lists both dev machines with their opencode versions", async () => {
    const res = await jar.fetch(`${API_URL}/gateway/sessions`);
    const sessions: any[] = await res.json();
    const v2 = sessions.find((s) => s.id === SESSION_ID_V2);
    const v1 = sessions.find((s) => s.id === SESSION_ID);
    expect(v2?.opencodeVersion).toBe(OPENCODE_V2_VERSION);
    expect(v1?.opencodeVersion).toMatch(/^1\./);
  });

  it("proxies GET /api/info with the CLI's Basic auth", async () => {
    const res = await getInfo();
    expect(res.status).toBe(200);
    expect((await res.json()).version).toBe(OPENCODE_V2_VERSION);
  });

  it("streams events through the tunnel", async () => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 20_000);
    try {
      const res = await jar.fetch(`${V2}/api/event`, { signal: abort.signal });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const reader = res.body!.getReader();
      const first = await reader.read();
      expect(first.done).toBe(false);
      expect(first.value!.length).toBeGreaterThan(0);
      await reader.cancel();
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
  });

  describe("guards", () => {
    it("refuses a route outside the allowlist: shell", async () => {
      await featureDisabled(await jar.fetch(`${V2}/api/shell`, { method: "POST", headers: JSON_HEADERS, body: "{}" }));
    });

    it("refuses a route outside the allowlist: the 1.x session API", async () => {
      await featureDisabled(await jar.fetch(`${V2}/session`));
    });

    it("refuses a route outside the allowlist: auth connect", async () => {
      await featureDisabled(await jar.fetch(`${V2}/auth/connect/x`));
    });

    it("refuses /auth/connect on a 1.x session", async () => {
      const res = await jar.fetch(`${API_URL}/proxy/${SESSION_ID}/auth/connect/x`);
      expect(res.status).toBe(403);
    });
  });

  describe("uploads disabled", () => {
    let sessionId: string;

    beforeAll(async () => {
      await getInfo();
      const res = await jar.fetch(`${V2}/api/session`, { method: "POST", headers: JSON_HEADERS, body: "{}" });
      expect(res.status).toBe(200);
      sessionId = (await res.json()).data.id;
      expect(sessionId).toBeTruthy();
    });

    it("refuses fs/write while uploads are disabled", async () => {
      await featureDisabled(
        await jar.fetch(`${V2}/api/experimental/fs/write?path=${encodeURIComponent("/tmp/x")}`, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: "x",
        })
      );
    });

    it("refuses a prompt with a data: file", async () => {
      const res = await jar.fetch(`${V2}/api/session/${sessionId}/prompt`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          text: "look at this",
          files: [{ uri: "data:text/plain;base64,aGVsbG8=", name: "hello.txt" }],
          resume: false,
        }),
      });
      await featureDisabled(res);
    });

    it("accepts a text-only prompt", async () => {
      // resume:false admits the input without starting the agent loop, so no model reply.
      const res = await jar.fetch(`${V2}/api/session/${sessionId}/prompt`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ text: "hello", resume: false }),
      });
      expect(res.status).toBe(200);
    });
  });

  describe("downloads disabled", () => {
    it("refuses fs/read", async () => {
      await getInfo();
      const res = await jar.fetch(`${V2}/api/fs/read/project/opencode.json`);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ _tag: "FeatureDisabled", message: "file downloads are disabled" });
    });

    it("still lists a directory", async () => {
      await getInfo();
      const res = await jar.fetch(`${V2}/api/fs/list?path=${encodeURIComponent("/project")}`);
      expect(res.status).toBe(200);
    });
  });

  describe("terminal enabled", () => {
    it("echoes a command through the API, gateway and tunnel", async () => {
      await getInfo();
      const created = await jar.fetch(`${V2}/api/pty`, { method: "POST", headers: JSON_HEADERS, body: "{}" });
      expect(created.status).toBe(200);
      const ptyId = (await created.json()).data.id;
      expect(ptyId).toBeTruthy();

      // The ticket request needs this header; opencode 2.x refuses it otherwise.
      const tokenRes = await jar.fetch(`${V2}/api/pty/${ptyId}/connect-token`, {
        method: "POST",
        headers: { "x-opencode-ticket": "1" },
      });
      expect(tokenRes.status).toBe(200);
      const ticket = (await tokenRes.json()).data.ticket;
      expect(ticket).toBeTruthy();

      const wsUrl =
        API_URL.replace(/^http/, "ws") +
        `/proxy/${SESSION_ID_V2}/api/pty/${ptyId}/connect?cursor=0&ticket=${encodeURIComponent(ticket)}` +
        `&access_token=${encodeURIComponent(jar.access)}`;
      const output = await new Promise<string>((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        ws.binaryType = "arraybuffer";
        let text = "";
        const timer = setTimeout(() => {
          ws.close();
          reject(new Error(`no echo within 15s, got: ${text.slice(-200)}`));
        }, 15_000);
        ws.onopen = () => ws.send("echo e2e-ws-v2-$((40+2))\n");
        ws.onmessage = (e) => {
          text += typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data as ArrayBuffer);
          if (text.includes("e2e-ws-v2-42")) {
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
      expect(output).toContain("e2e-ws-v2-42");
    });
  });
});
