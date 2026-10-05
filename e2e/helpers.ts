// Shared by the e2e test files: service URLs and logging in through the OIDC mock.
import { expect } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { WebSocket } from "ws";

export const API_URL = process.env.API_URL ?? "http://opencode-rc-api:8080";
export const UI_URL = process.env.UI_URL ?? "http://opencode-rc-ui:8080";
export const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://opencode-rc-gateway:9090";
export const OIDC_URL = process.env.OIDC_URL ?? "http://opencode-rc-oidc-mock:8080";
export const OIDC_CLIENT_ID = process.env.WEB_OIDC_CLIENT_ID ?? "opencode-rc";
export const SESSION_ID = process.env.OPENCODE_RC_SESSION_ID ?? "alice-dev";

export const PROTOCOL = { "OpenCode-RC-Protocol": "1" };

export async function waitFor(
  name: string,
  url: string,
  maxSeconds = 60
): Promise<void> {
  for (let i = 1; i <= maxSeconds; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${name} not ready after ${maxSeconds}s`);
}

export class TokenSession {
  constructor(public access: string, public refresh: string) {}

  async fetch(url: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${this.access}`);
    headers.set("OpenCode-RC-Protocol", "1");
    return fetch(url, { ...init, headers, redirect: "manual" });
  }
}

export function cookieHeader(res: Response): string {
  return (res.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(";")[0])
    .filter((pair) => !pair.endsWith("="))
    .join("; ");
}

export async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...PROTOCOL },
    body: JSON.stringify(body),
  });
}

export interface LoginCode {
  code: string;
  verifier: string;
}

export async function loginCode(sub: string): Promise<LoginCode> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const startRes = await fetch(`${API_URL}/auth/start?return_to=%2F&code_challenge=${challenge}`, {
    redirect: "manual",
  });
  expect(startRes.status).toBe(302);
  const cookies = cookieHeader(startRes);
  const url = new URL(startRes.headers.get("location")!);

  const callbackRes = await fetch(`${OIDC_URL}/authorize/callback`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      sub,
      client_id: OIDC_CLIENT_ID,
      redirect_uri: url.searchParams.get("redirect_uri")!,
      state: url.searchParams.get("state")!,
      nonce: "",
      scope: "openid email profile",
      code_challenge: "",
      code_challenge_method: "",
    }),
    redirect: "manual",
  });
  const webCallback = await fetch(callbackRes.headers.get("location")!, {
    headers: { cookie: cookies },
    redirect: "manual",
  });
  expect(webCallback.status).toBe(302);
  const landing = new URL(webCallback.headers.get("location")!, API_URL);
  const code = new URLSearchParams(landing.hash.slice(1)).get("code");
  expect(code).toBeTruthy();
  return { code: code!, verifier };
}

export async function loginAs(sub: string): Promise<TokenSession> {
  const { code, verifier } = await loginCode(sub);
  const res = await postJson("/auth/token", { code, code_verifier: verifier });
  expect(res.status).toBe(200);
  const body = await res.json();
  return new TokenSession(body.access_token, body.refresh_token);
}

// The HTTP status of a WebSocket upgrade: 101 when it opens, else the refusal's status.
export function upgradeStatus(url: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.on("open", () => {
      resolve(101);
      ws.close();
    });
    ws.on("error", reject);
  });
}
