import { Elysia } from "elysia";
import { COOKIE_NAME, getSession } from "./auth";
import { env } from "./env";
import { ApiError } from "./http";
import { db } from "./db/client";
import { users } from "./db/schema";
import { eq } from "drizzle-orm";

const RATE_PREFIX = "rims:rl:login:";
const RATE_USER_PREFIX = "rims:rl:login-user:";

export type AuthUser = {
  id: string;
  username: string;
  name: string;
  permissions: Record<string, boolean>;
};

export function requirePerm(user: AuthUser | null | undefined, perm: string): asserts user is AuthUser {
  if (!user) throw new ApiError(401, "Belum login");
  if (user.permissions?.[perm] !== true) {
    throw new ApiError(403, "Tidak memiliki akses");
  }
}

type MinimalServer = {
  requestIP(request: Request): { address: string; family: string; port: number } | null;
};

/**
 * IP klien untuk rate limiting. Header X-Forwarded-For hanya dipercaya bila
 * TRUST_PROXY=true (API di belakang reverse proxy terpercaya) — kalau tidak,
 * header itu dikendalikan klien dan bisa dipalsukan untuk mem-bypass limit.
 */
export function getClientIp(
  request: Request,
  server: MinimalServer | null | undefined,
  headers: Headers,
): string {
  if (!env.trustProxy) {
    return server?.requestIP(request)?.address ?? "local";
  }
  const xff = headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return headers.get("x-real-ip") ?? server?.requestIP(request)?.address ?? "local";
}

/** Heal race incr/expire: kunci tanpa TTL diberi TTL ulang, bukan lockout abadi. */
async function ensureTtl(key: string, seconds: number): Promise<void> {
  const ttl = await Bun.redis.ttl(key);
  if (ttl < 0) await Bun.redis.expire(key, seconds);
}

export async function checkLoginRate(ip: string, username: string): Promise<{ ok: boolean; remaining: number }> {
  const key = `${RATE_PREFIX}${ip}:${username.trim().toLowerCase()}`;
  const count = await Bun.redis.incr(key);
  if (count === 1) await Bun.redis.expire(key, 60);
  else await ensureTtl(key, 60);
  return { ok: count <= 5, remaining: Math.max(0, 5 - count) };
}

/**
 * Limit global per-username (tidak tergantung IP) — memblokir brute force
 * terdistribusi yang merotasi X-Forwarded-For untuk satu akun target.
 */
export async function checkUsernameRate(username: string): Promise<boolean> {
  const key = `${RATE_USER_PREFIX}${username.trim().toLowerCase()}`;
  const count = await Bun.redis.incr(key);
  if (count === 1) await Bun.redis.expire(key, 60);
  else await ensureTtl(key, 60);
  return count <= 20;
}

export async function clearLoginRates(ip: string, username: string) {
  const u = username.trim().toLowerCase();
  await Bun.redis.del(`${RATE_PREFIX}${ip}:${u}`, `${RATE_USER_PREFIX}${u}`);
}

export function securityHeadersPlugin() {
  return new Elysia({ name: "security-headers" }).onAfterHandle(({ set }) => {
    const h = (set.headers ??= {}) as Record<string, string>;
    h["Content-Security-Policy"] =
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'self'; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'";
    h["X-Content-Type-Options"] = "nosniff";
    h["X-Frame-Options"] = "DENY";
    h["Referrer-Policy"] = "no-referrer";
    h["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()";
    if (env.isProd) h["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  });
}

export function authGuard() {
  return new Elysia({ name: "auth-guard" }).derive(
    { as: "scoped" },
    async ({ cookie, headers }): Promise<{ user: AuthUser | null; authed: boolean; sessionToken: string | null }> => {
      const bearer = headers["authorization"]?.startsWith("Bearer ")
        ? headers["authorization"].slice(7)
        : "";
      const token = (cookie[COOKIE_NAME]?.value ?? bearer) as string;
      const session = await getSession(token);
      if (!session) {
        return { user: null, authed: false, sessionToken: null };
      }
      const [row] = await db
        .select({ id: users.id, username: users.username, name: users.name, permissions: users.permissions })
        .from(users)
        .where(eq(users.id, session.userId))
        .limit(1);
      if (!row) {
        return { user: null, authed: false, sessionToken: null };
      }
      return { user: row, authed: true, sessionToken: token };
    },
  );
}
