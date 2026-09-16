import Redis from "ioredis";

export interface SessionMeta {
  id: string;
  userId: string;
  directory: string;
  tunnelerAddr: string;
  createdAt: string;
}

export class SessionStore {
  constructor(private redis: Redis) {}

  async get(sessionId: string): Promise<SessionMeta | null> {
    const data = await this.redis.get(`orc:session:${sessionId}`);
    if (!data) return null;
    return JSON.parse(data);
  }

  async list(userId: string): Promise<SessionMeta[]> {
    const ids = await this.redis.smembers(`orc:user-sessions:${userId}`);
    if (ids.length === 0) return [];

    const keys = ids.map((id) => `orc:session:${id}`);
    const values = await this.redis.mget(...keys);

    const result: SessionMeta[] = [];
    const staleIds: string[] = [];

    for (let i = 0; i < values.length; i++) {
      if (values[i] === null) {
        staleIds.push(ids[i]);
        continue;
      }
      try {
        result.push(JSON.parse(values[i]!));
      } catch {
        // skip malformed entries
      }
    }

    if (staleIds.length > 0) {
      this.redis.srem(`orc:user-sessions:${userId}`, ...staleIds);
    }

    return result;
  }

  async ping(): Promise<boolean> {
    try {
      await this.redis.ping();
      return true;
    } catch {
      return false;
    }
  }
}
