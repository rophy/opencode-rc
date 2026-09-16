import { describe, it, expect } from "vitest";
import { encodeCookie, decodeCookie, generateState, type SessionData } from "./cookie.js";

const secret = new Uint8Array(32);
secret.fill(0xab);

const session: SessionData = {
  uid: "alice@example.com",
  email: "alice@example.com",
  name: "Alice",
  exp: Math.floor(Date.now() / 1000) + 3600,
};

describe("encodeCookie / decodeCookie", () => {
  it("round-trips session data", () => {
    const encoded = encodeCookie(session, secret);
    const decoded = decodeCookie(encoded, secret);
    expect(decoded).toEqual(session);
  });

  it("returns null for tampered payload", () => {
    const encoded = encodeCookie(session, secret);
    const tampered = "x" + encoded.slice(1);
    expect(decodeCookie(tampered, secret)).toBeNull();
  });

  it("returns null for wrong secret", () => {
    const encoded = encodeCookie(session, secret);
    const other = new Uint8Array(32);
    other.fill(0xcd);
    expect(decodeCookie(encoded, other)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(decodeCookie("", secret)).toBeNull();
  });

  it("returns null for garbage", () => {
    expect(decodeCookie("not.valid.base64url.data", secret)).toBeNull();
  });

  it("returns null for missing signature", () => {
    expect(decodeCookie("nodot", secret)).toBeNull();
  });
});

describe("generateState", () => {
  it("returns 32-char hex string", () => {
    const state = generateState();
    expect(state).toMatch(/^[0-9a-f]{32}$/);
  });

  it("returns unique values", () => {
    const a = generateState();
    const b = generateState();
    expect(a).not.toBe(b);
  });
});
