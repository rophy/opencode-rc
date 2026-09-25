import { hashToken, randomToken, type AccessClaims } from "./token.js";

export interface RedisLike {
  get(key: string): Promise<string | null>;
  getdel(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: (string | number)[]): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  ttl(key: string): Promise<number>;
}

export type RotateResult =
  | { ok: true; refreshToken: string; claims: AccessClaims }
  | { ok: false };

export const REFRESH_GRACE_SECONDS = 30;

export interface LoginCodeRecord {
  claims: AccessClaims;
  challenge: string;
}

interface RefreshRecord extends AccessClaims {
  chain: string;
}

const key = {
  code: (code: string) => `orc:code:${code}`,
  chain: (id: string) => `orc:chain:${id}`,
  rt: (hash: string) => `orc:rt:${hash}`,
  used: (hash: string) => `orc:rtused:${hash}`,
  grace: (hash: string) => `orc:rtgrace:${hash}`,
};

export class TokenStore {
  constructor(
    private redis: RedisLike,
    private sessionTtlSeconds: number,
    private codeTtlSeconds = 60,
  ) {}

  async createCode(claims: AccessClaims, challenge: string): Promise<string> {
    const code = randomToken();
    const record: LoginCodeRecord = { claims, challenge };
    await this.redis.set(key.code(code), JSON.stringify(record), "EX", this.codeTtlSeconds);
    return code;
  }

  async consumeCode(code: string): Promise<LoginCodeRecord | null> {
    const raw = await this.redis.getdel(key.code(code));
    return raw ? (JSON.parse(raw) as LoginCodeRecord) : null;
  }

  async createChain(claims: AccessClaims): Promise<string> {
    const chain = randomToken(16);
    await this.redis.set(key.chain(chain), claims.uid, "EX", this.sessionTtlSeconds);
    return this.issue({ chain, ...claims }, this.sessionTtlSeconds);
  }

  async rotate(refreshToken: string): Promise<RotateResult> {
    const hash = hashToken(refreshToken);
    const raw = await this.redis.get(key.rt(hash));
    if (!raw) return { ok: false };
    const record = JSON.parse(raw) as RefreshRecord;
    const ttl = await this.redis.ttl(key.chain(record.chain));
    if (ttl <= 0) return { ok: false };
    const claims: AccessClaims = { uid: record.uid, email: record.email, name: record.name };

    if (await this.redis.get(key.used(hash))) {
      const graced = await this.redis.get(key.grace(hash));
      if (graced) return { ok: true, refreshToken: graced, claims };
      await this.redis.del(key.chain(record.chain));
      return { ok: false };
    }

    const next = randomToken();
    const claimed = await this.redis.set(key.grace(hash), next, "EX", REFRESH_GRACE_SECONDS, "NX");
    if (claimed !== "OK") {
      const graced = await this.redis.get(key.grace(hash));
      return graced ? { ok: true, refreshToken: graced, claims } : { ok: false };
    }
    await this.issueToken(next, record, ttl);
    await this.redis.set(key.used(hash), "1", "EX", ttl);
    return { ok: true, refreshToken: next, claims };
  }

  async revoke(refreshToken: string): Promise<void> {
    const raw = await this.redis.get(key.rt(hashToken(refreshToken)));
    if (!raw) return;
    const record = JSON.parse(raw) as RefreshRecord;
    await this.redis.del(key.chain(record.chain));
  }

  private async issue(record: RefreshRecord, ttl: number): Promise<string> {
    const token = randomToken();
    await this.issueToken(token, record, ttl);
    return token;
  }

  private async issueToken(token: string, record: RefreshRecord, ttl: number): Promise<void> {
    const value: RefreshRecord = {
      chain: record.chain,
      uid: record.uid,
      email: record.email,
      name: record.name,
    };
    await this.redis.set(key.rt(hashToken(token)), JSON.stringify(value), "EX", ttl);
  }
}
