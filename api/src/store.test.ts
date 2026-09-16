import { describe, it, expect, beforeEach } from "vitest";
import { SessionStore, type SessionMeta } from "./store.js";

class MockRedis {
  private data = new Map<string, string>();
  private sets = new Map<string, Set<string>>();

  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }

  async mget(...keys: string[]): Promise<(string | null)[]> {
    return keys.map((k) => this.data.get(k) ?? null);
  }

  async smembers(key: string): Promise<string[]> {
    return Array.from(this.sets.get(key) ?? []);
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    const set = this.sets.get(key);
    if (!set) return 0;
    let count = 0;
    for (const m of members) {
      if (set.delete(m)) count++;
    }
    return count;
  }

  async ping(): Promise<string> {
    return "PONG";
  }

  putSession(meta: SessionMeta) {
    this.data.set(`orc:session:${meta.id}`, JSON.stringify(meta));
    const setKey = `orc:user-sessions:${meta.userId}`;
    if (!this.sets.has(setKey)) this.sets.set(setKey, new Set());
    this.sets.get(setKey)!.add(meta.id);
  }

  addStaleRef(userId: string, sessionId: string) {
    const setKey = `orc:user-sessions:${userId}`;
    if (!this.sets.has(setKey)) this.sets.set(setKey, new Set());
    this.sets.get(setKey)!.add(sessionId);
  }
}

describe("SessionStore", () => {
  let redis: MockRedis;
  let store: SessionStore;

  beforeEach(() => {
    redis = new MockRedis();
    store = new SessionStore(redis as any);
  });

  describe("get", () => {
    it("returns null for missing session", async () => {
      expect(await store.get("nonexistent")).toBeNull();
    });

    it("returns session when present", async () => {
      redis.putSession({
        id: "sess-1",
        userId: "alice@example.com",
        directory: "/home/alice/project",
        tunnelerAddr: "tunneler:9090",
        createdAt: "2026-01-01T00:00:00Z",
      });
      const result = await store.get("sess-1");
      expect(result).not.toBeNull();
      expect(result!.id).toBe("sess-1");
      expect(result!.userId).toBe("alice@example.com");
      expect(result!.directory).toBe("/home/alice/project");
    });
  });

  describe("list", () => {
    it("returns empty array when user has no sessions", async () => {
      const result = await store.list("nobody@example.com");
      expect(result).toEqual([]);
    });

    it("returns all sessions for user", async () => {
      redis.putSession({
        id: "sess-1",
        userId: "alice@example.com",
        directory: "/project-a",
        tunnelerAddr: "t:9090",
        createdAt: "2026-01-01T00:00:00Z",
      });
      redis.putSession({
        id: "sess-2",
        userId: "alice@example.com",
        directory: "/project-b",
        tunnelerAddr: "t:9090",
        createdAt: "2026-01-01T00:00:00Z",
      });
      const result = await store.list("alice@example.com");
      expect(result).toHaveLength(2);
      const ids = result.map((s) => s.id).sort();
      expect(ids).toEqual(["sess-1", "sess-2"]);
    });

    it("cleans up stale references", async () => {
      redis.putSession({
        id: "sess-1",
        userId: "alice@example.com",
        directory: "/project",
        tunnelerAddr: "t:9090",
        createdAt: "2026-01-01T00:00:00Z",
      });
      redis.addStaleRef("alice@example.com", "sess-gone");

      const result = await store.list("alice@example.com");
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("sess-1");

      const members = await redis.smembers("orc:user-sessions:alice@example.com");
      expect(members).not.toContain("sess-gone");
    });

    it("does not return other users sessions", async () => {
      redis.putSession({
        id: "sess-1",
        userId: "alice@example.com",
        directory: "/project",
        tunnelerAddr: "t:9090",
        createdAt: "2026-01-01T00:00:00Z",
      });
      const result = await store.list("bob@example.com");
      expect(result).toEqual([]);
    });
  });

  describe("ping", () => {
    it("returns true when redis responds", async () => {
      expect(await store.ping()).toBe(true);
    });

    it("returns false when redis throws", async () => {
      const broken = {
        ping: async () => { throw new Error("connection refused"); },
      };
      const brokenStore = new SessionStore(broken as any);
      expect(await brokenStore.ping()).toBe(false);
    });
  });
});
