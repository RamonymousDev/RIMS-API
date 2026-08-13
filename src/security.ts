import { Elysia } from "elysia";
import { COOKIE_NAME, getSession } from "./auth";
import { env } from "./env";
import { ApiError } from "./http";
import { db } from "./db/client";
import { users } from "./db/schema";
import { eq } from "drizzle-orm";

const RATE_PREFIX = "rims:rl:login:";

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

export function checkLoginRate(ip: string, username: string): Promise<{ ok: boolean; remaining: number }> {
  const key = `${RATE_PREFIX}${ip}:${username.trim().toLowerCase()}`;
  return Bun.redis.incr(key).then((count) => {
    if (count === 1) Bun.redis.expire(key, 60);
    return { ok: count <= 5, remaining: Math.max(0, 5 - count) };
  });
}

export async function clearLoginRate(ip: string) {
  await Bun.redis.del(RATE_PREFIX + ip);
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
