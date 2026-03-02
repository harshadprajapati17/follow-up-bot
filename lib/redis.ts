import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

const SESSION_PREFIX = "session:";

const buildSessionKey = (key: string): string => `${SESSION_PREFIX}${key}`;

export { redis };

export async function getSession<T = unknown>(key: string): Promise<T | null> {
  const value = await redis.get<T>(buildSessionKey(key));
  return value ?? null;
}

export async function setSession<T>(
  key: string,
  value: T,
  ttl: number
): Promise<void> {
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new Error("ttl must be a positive number of seconds");
  }

  await redis.set(buildSessionKey(key), value, { ex: ttl });
}

export async function deleteSession(key: string): Promise<void> {
  await redis.del(buildSessionKey(key));
}

