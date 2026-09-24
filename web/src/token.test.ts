import { describe, it, expect } from "vitest";
import {
  signAccessToken,
  verifyAccessToken,
  randomToken,
  hashToken,
  codeChallenge,
  isCodeChallenge,
  verifyCodeVerifier,
} from "./token.js";
import { createHmac } from "node:crypto";

const secret = new Uint8Array(32).fill(0xab);
const claims = { uid: "alice@example.com", email: "alice@example.com", name: "Alice" };

describe("access tokens", () => {
  it("round-trips claims", () => {
    const token = signAccessToken(claims, secret, 900);
    expect(verifyAccessToken(token, secret)).toEqual(claims);
  });

  it("rejects an expired token", () => {
    const t0 = Date.now();
    const token = signAccessToken(claims, secret, 900, t0);
    expect(verifyAccessToken(token, secret, t0 + 899_000)).toEqual(claims);
    expect(verifyAccessToken(token, secret, t0 + 900_000)).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const token = signAccessToken(claims, secret, 900);
    expect(verifyAccessToken("x" + token.slice(1), secret)).toBeNull();
  });

  it("rejects a different secret", () => {
    const token = signAccessToken(claims, secret, 900);
    expect(verifyAccessToken(token, new Uint8Array(32).fill(0xcd))).toBeNull();
  });

  it("rejects a correctly signed payload without typ=access", () => {
    const payload = Buffer.from(
      JSON.stringify({ uid: "alice", email: "", name: "", exp: Math.floor(Date.now() / 1000) + 900 }),
    ).toString("base64url");
    const mac = createHmac("sha256", secret).update(payload).digest("base64url");
    expect(verifyAccessToken(`${payload}.${mac}`, secret)).toBeNull();
  });

  it("rejects garbage", () => {
    expect(verifyAccessToken("", secret)).toBeNull();
    expect(verifyAccessToken("abc", secret)).toBeNull();
    expect(verifyAccessToken("a.b.c", secret)).toBeNull();
  });
});

describe("randomToken / hashToken", () => {
  it("produces distinct url-safe tokens", () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("hashes deterministically to hex", () => {
    expect(hashToken("abc")).toBe(hashToken("abc"));
    expect(hashToken("abc")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("code challenge", () => {
  // RFC 7636 appendix B
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

  it("computes the S256 challenge", () => {
    expect(codeChallenge(verifier)).toBe(challenge);
    expect(isCodeChallenge(challenge)).toBe(true);
  });

  it("rejects malformed challenges", () => {
    expect(isCodeChallenge(undefined)).toBe(false);
    expect(isCodeChallenge("short")).toBe(false);
    expect(isCodeChallenge(challenge + "A")).toBe(false);
    expect(isCodeChallenge(challenge.slice(0, 42) + "=")).toBe(false);
  });

  it("verifies only the matching verifier", () => {
    expect(verifyCodeVerifier(verifier, challenge)).toBe(true);
    expect(verifyCodeVerifier(randomToken(), challenge)).toBe(false);
    expect(verifyCodeVerifier(null, challenge)).toBe(false);
    expect(verifyCodeVerifier("short", codeChallenge("short"))).toBe(false);
  });
});
