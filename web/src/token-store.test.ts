import { describe, it, expect, beforeEach } from "vitest";
import { TokenStore, REFRESH_GRACE_SECONDS } from "./token-store.js";
import { MockRedis } from "./testing/mock-redis.js";

const claims = { uid: "alice@example.com", email: "alice@example.com", name: "Alice" };
const WEEK = 7 * 24 * 3600;

let redis: MockRedis;
let store: TokenStore;

beforeEach(() => {
  redis = new MockRedis();
  store = new TokenStore(redis, WEEK);
});

describe("login codes", () => {
  it("can be consumed once", async () => {
    const code = await store.createCode(claims, "challenge");
    expect(await store.consumeCode(code)).toEqual({ claims, challenge: "challenge" });
    expect(await store.consumeCode(code)).toBeNull();
  });

  it("expire after 60 seconds", async () => {
    const code = await store.createCode(claims, "challenge");
    redis.advance(60);
    expect(await store.consumeCode(code)).toBeNull();
  });
});

describe("refresh rotation", () => {
  it("rotates to a new token with the same claims", async () => {
    const t1 = await store.createChain(claims);
    const r = await store.rotate(t1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.refreshToken).not.toBe(t1);
    expect(r.claims).toEqual(claims);
    const r2 = await store.rotate(r.refreshToken);
    expect(r2.ok).toBe(true);
  });

  it("returns the same next token when reused within the grace window", async () => {
    const t1 = await store.createChain(claims);
    const a = await store.rotate(t1);
    redis.advance(REFRESH_GRACE_SECONDS - 1);
    const b = await store.rotate(t1);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.refreshToken).toBe(a.refreshToken);
  });

  it("revokes the chain when reused after the grace window", async () => {
    const t1 = await store.createChain(claims);
    const a = await store.rotate(t1);
    redis.advance(REFRESH_GRACE_SECONDS);
    expect((await store.rotate(t1)).ok).toBe(false);
    if (!a.ok) return;
    // the legitimate successor is dead too
    expect((await store.rotate(a.refreshToken)).ok).toBe(false);
  });

  it("stops working at the absolute session expiry", async () => {
    let t = await store.createChain(claims);
    for (let i = 0; i < 6; i++) {
      redis.advance(24 * 3600);
      const r = await store.rotate(t);
      expect(r.ok).toBe(true);
      if (r.ok) t = r.refreshToken;
    }
    redis.advance(24 * 3600);
    expect((await store.rotate(t)).ok).toBe(false);
  });

  it("rejects unknown tokens", async () => {
    expect((await store.rotate("nope")).ok).toBe(false);
  });

  it("revoke ends the chain", async () => {
    const t1 = await store.createChain(claims);
    await store.revoke(t1);
    expect((await store.rotate(t1)).ok).toBe(false);
  });

  it("revoke of an unknown token is a no-op", async () => {
    await expect(store.revoke("nope")).resolves.toBeUndefined();
  });
});
