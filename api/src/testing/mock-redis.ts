import type { RedisLike } from "../token-store.js";

interface Entry {
  value: string;
  expiresAt: number | null; // seconds on the mock clock
}

// In-memory subset of Redis used by TokenStore, with a manual clock.
export class MockRedis implements RedisLike {
  private data = new Map<string, Entry>();
  private now = 0;

  advance(seconds: number): void {
    this.now += seconds;
  }

  private live(key: string): Entry | undefined {
    const e = this.data.get(key);
    if (!e) return undefined;
    if (e.expiresAt !== null && e.expiresAt <= this.now) {
      this.data.delete(key);
      return undefined;
    }
    return e;
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async getdel(key: string): Promise<string | null> {
    const v = this.live(key)?.value ?? null;
    this.data.delete(key);
    return v;
  }

  async set(key: string, value: string, ...args: (string | number)[]): Promise<string | null> {
    let ex: number | null = null;
    let nx = false;
    for (let i = 0; i < args.length; i++) {
      const a = String(args[i]).toUpperCase();
      if (a === "EX") ex = Number(args[++i]);
      else if (a === "NX") nx = true;
    }
    if (nx && this.live(key)) return null;
    this.data.set(key, { value, expiresAt: ex === null ? null : this.now + ex });
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) if (this.data.delete(k)) n++;
    return n;
  }

  async ttl(key: string): Promise<number> {
    const e = this.live(key);
    if (!e) return -2;
    if (e.expiresAt === null) return -1;
    return e.expiresAt - this.now;
  }
}
