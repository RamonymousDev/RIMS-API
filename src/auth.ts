import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "./db/client";
import { users } from "./db/schema";
import { env } from "./env";
import { fullPermissions } from "./permissions";

const SESSION_PREFIX = "session:";
const USER_SESSIONS_PREFIX = "user_sessions:";
export const SESSION_TTL_ABSOLUTE = 60 * 60 * 24; // 24 jam
export const SESSION_TTL_IDLE = 60 * 60 * 2; // 2 jam idle

export const COOKIE_NAME = env.isProd ? "__Host-rims_session" : "rims_session";

export type SessionPayload = {
  userId: string;
  username: string;
  createdAt: number;
};

export async function ensureAdminUser() {
  const [existing] = await db.select().from(users).where(eq(users.username, env.ADMIN_USERNAME)).limit(1);
  if (!existing) {
    const hash = await Bun.password.hash(env.ADMIN_PASSWORD, { algorithm: "argon2id" });
    await db.insert(users).values({
      username: env.ADMIN_USERNAME,
      passwordHash: hash,
      name: "Administrator",
      permissions: fullPermissions(),
      isBootstrap: true,
    });
    console.log(`[auth] user admin "${env.ADMIN_USERNAME}" dibuat.`);
    return;
  }
  // bootstrap admin selalu penuh — ikut katalog permission terbaru
  await db
    .update(users)
    .set({ permissions: fullPermissions() })
    .where(eq(users.id, existing.id));
}

export async function createSession(userId: string, username: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const payload: SessionPayload = { userId, username, createdAt: Date.now() };
  await Bun.redis.set(
    SESSION_PREFIX + token,
    JSON.stringify(payload),
    "EX",
    String(SESSION_TTL_ABSOLUTE),
    "NX",
  );
  Bun.redis.sadd(USER_SESSIONS_PREFIX + userId, token).catch(() => {});
  return token;
}

export async function getSession(token: string): Promise<SessionPayload | null> {
  if (!token) return null;
  const raw = await Bun.redis.get(SESSION_PREFIX + token);
  if (!raw) return null;
  try {
    const payload = JSON.parse(raw) as SessionPayload;
    if (!payload.userId) return null;
    // sliding idle: refresh ke 2 jam idle, tapi tetap dibatasi absolut 24 jam sejak dibuat
    const now = Date.now();
    const absoluteLeft = payload.createdAt + SESSION_TTL_ABSOLUTE * 1000 - now;
    const ttlSeconds = Math.floor(Math.min(absoluteLeft, SESSION_TTL_IDLE * 1000) / 1000);
    if (ttlSeconds <= 0) {
      await destroySession(token);
      return null;
    }
    await Bun.redis.expire(SESSION_PREFIX + token, ttlSeconds);
    return payload;
  } catch {
    return null;
  }
}

export async function destroySession(token: string) {
  if (!token) return;
  const raw = await Bun.redis.get(SESSION_PREFIX + token);
  await Bun.redis.del(SESSION_PREFIX + token);
  if (raw) {
    try {
      const payload = JSON.parse(raw) as SessionPayload;
      if (payload.userId) {
        Bun.redis.srem(USER_SESSIONS_PREFIX + payload.userId, token).catch(() => {});
      }
    } catch {
      /* ignore */
    }
  }
}

export async function destroyUserSessions(userId: string) {
  const key = USER_SESSIONS_PREFIX + userId;
  const tokens = await Bun.redis.smembers(key);
  if (tokens.length > 0) {
    await Bun.redis.del(...tokens.map((t) => SESSION_PREFIX + t));
  }
  await Bun.redis.del(key);
}

export type SessionInfo = {
  token: string;
  username: string;
  createdAt: number;
  ttlSeconds: number;
};

export async function listUserSessions(userId: string): Promise<SessionInfo[]> {
  const key = USER_SESSIONS_PREFIX + userId;
  const tokens = await Bun.redis.smembers(key);
  const out: SessionInfo[] = [];
  for (const token of tokens) {
    const raw = await Bun.redis.get(SESSION_PREFIX + token);
    if (!raw) continue;
    try {
      const payload = JSON.parse(raw) as SessionPayload;
      const ttl = await Bun.redis.ttl(SESSION_PREFIX + token);
      if (ttl <= 0) continue;
      out.push({
        token,
        username: payload.username,
        createdAt: payload.createdAt,
        ttlSeconds: ttl,
      });
    } catch {
      /* skip malformed */
    }
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

export async function sessionBelongsToUser(token: string, userId: string): Promise<boolean> {
  return Bun.redis.sismember(USER_SESSIONS_PREFIX + userId, token);
}

export function cookieFor(token: string, maxAge: number): string {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (env.isProd) parts.push("Secure");
  if (env.COOKIE_DOMAIN) parts.push(`Domain=${env.COOKIE_DOMAIN}`);
  return parts.join("; ");
}

export function clearCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}
