import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { Config } from "../src/config.js";

vi.mock("node:child_process", () => ({ exec: vi.fn() }));

import {
  authorizationCodeAuth,
  generateCodeVerifier,
  generateCodeChallenge,
  listenOnAvailablePort,
} from "../src/oidc.js";

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    tunnelerUrl: "http://localhost",
    oidcIssuer: "http://localhost",
    oidcClientID: "test-client",
    oidcTokenEndpoint: "http://127.0.0.1:18950/token",
    oidcAuthorizationEndpoint: "http://127.0.0.1:18950/authorize",
    oidcCallbackPorts: [18951, 18952],
    ...overrides,
  };
}

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
}

async function close(server: Server): Promise<void> {
  const done = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeAllConnections?.();
  await done;
}

describe("generateCodeVerifier", () => {
  it("returns a base64url string of expected length", () => {
    const verifier = generateCodeVerifier();
    expect(typeof verifier).toBe("string");
    expect(verifier.length).toBe(43);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("returns different values on each call", () => {
    expect(generateCodeVerifier()).not.toBe(generateCodeVerifier());
  });
});

describe("generateCodeChallenge", () => {
  it("produces the expected SHA256 base64url digest", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    expect(generateCodeChallenge(verifier)).toBe(expected);
  });
});

describe("listenOnAvailablePort", () => {
  let busyServer: Server | undefined;
  let target: Server | undefined;

  afterEach(async () => {
    if (target) await close(target);
    if (busyServer) await close(busyServer);
    target = undefined;
    busyServer = undefined;
  });

  it("skips a busy port and binds the next one", async () => {
    busyServer = createServer();
    await listen(busyServer, 18900);

    target = createServer();
    const port = await listenOnAvailablePort(target, [18900, 18901]);
    expect(port).toBe(18901);
  });

  it("rejects when all ports are busy", async () => {
    busyServer = createServer();
    await listen(busyServer, 18900);
    const secondBusy = createServer();
    await listen(secondBusy, 18901);

    target = createServer();
    await expect(
      listenOnAvailablePort(target, [18900, 18901])
    ).rejects.toThrow("All callback ports in use");

    await close(secondBusy);
  });
});

describe("authorizationCodeAuth", () => {
  let tokenServer: Server;
  let tokenStatus = 200;
  let origLog: typeof console.log;
  let capturedUrl: string;

  beforeEach(async () => {
    tokenStatus = 200;
    capturedUrl = "";
    origLog = console.log;
    console.log = (...args: unknown[]) => {
      const msg = args.map(String).join(" ");
      if (msg.includes("http://")) capturedUrl = msg.trim();
    };

    tokenServer = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        if (tokenStatus !== 200) {
          res.writeHead(tokenStatus, { "Content-Type": "text/plain" });
          res.end("bad request");
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id_token: "mock-id-token",
            access_token: "mock-access",
            token_type: "Bearer",
            expires_in: 3600,
          })
        );
      });
    });
    await listen(tokenServer, 18950);
  });

  afterEach(async () => {
    console.log = origLog;
    await close(tokenServer);
  });

  function extractState(url: string): string {
    const parsed = new URL(url);
    const state = parsed.searchParams.get("state");
    if (!state) throw new Error(`no state found in captured url: ${url}`);
    return state;
  }

  it("completes the full flow and returns tokens", async () => {
    const promise = authorizationCodeAuth(baseConfig({ oidcCallbackPorts: [18951, 18952] }));
    await vi.waitFor(() => expect(capturedUrl).not.toBe(""));

    const state = extractState(capturedUrl);
    const port = new URL(new URL(capturedUrl).searchParams.get("redirect_uri")!).port;

    await fetch(`http://127.0.0.1:${port}/callback?code=test-code&state=${state}`);

    const result = await promise;
    expect(result.idToken).toBe("mock-id-token");
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  it("rejects on authorization error callback", async () => {
    const promise = authorizationCodeAuth(baseConfig({ oidcCallbackPorts: [18953, 18954] }));
    promise.catch(() => {});
    await vi.waitFor(() => expect(capturedUrl).not.toBe(""));

    const port = new URL(new URL(capturedUrl).searchParams.get("redirect_uri")!).port;
    await fetch(
      `http://127.0.0.1:${port}/callback?error=access_denied&error_description=user+denied`
    );

    await expect(promise).rejects.toThrow("Authorization error");
  });

  it("rejects on state mismatch", async () => {
    const promise = authorizationCodeAuth(baseConfig({ oidcCallbackPorts: [18955, 18956] }));
    promise.catch(() => {});
    await vi.waitFor(() => expect(capturedUrl).not.toBe(""));

    const port = new URL(new URL(capturedUrl).searchParams.get("redirect_uri")!).port;
    await fetch(`http://127.0.0.1:${port}/callback?code=test-code&state=wrong-state`);

    await expect(promise).rejects.toThrow("State mismatch");
  });

  it("rejects when token exchange fails", async () => {
    tokenStatus = 400;
    const promise = authorizationCodeAuth(baseConfig({ oidcCallbackPorts: [18957, 18958] }));
    promise.catch(() => {});
    await vi.waitFor(() => expect(capturedUrl).not.toBe(""));

    const state = extractState(capturedUrl);
    const port = new URL(new URL(capturedUrl).searchParams.get("redirect_uri")!).port;
    await fetch(`http://127.0.0.1:${port}/callback?code=test-code&state=${state}`);

    await expect(promise).rejects.toThrow("Token exchange failed");
  });
});
