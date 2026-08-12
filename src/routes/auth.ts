import { Elysia, t } from "elysia";
import { eq, sql } from "drizzle-orm";
import { clearCookie, cookieFor, createSession, destroySession } from "../auth";
import { ApiError } from "../http";
import { authGuard, checkLoginRate, clearLoginRate, requirePerm } from "../security";
import { COOKIE_NAME } from "../auth";
import { db } from "../db/client";
import { users } from "../db/schema";
import { logAudit } from "../audit";

const loginSchema = t.Object({
  username: t.String({ minLength: 1, maxLength: 64 }),
  password: t.String({ minLength: 1, maxLength: 256 }),
});

const changePasswordSchema = t.Object({
  currentPassword: t.String({ minLength: 1, maxLength: 256 }),
  newPassword: t.String({ minLength: 8, maxLength: 256 }),
});

export const authRoutes = new Elysia({ prefix: "/api/auth" }).use(authGuard())
  .post(
    "/login",
    async ({ body, set, request }) => {
      const ip = (request.headers.get("x-forwarded-for")?.split(",")[0] ?? request.headers.get("x-real-ip") ?? "local").trim();

      const rate = await checkLoginRate(ip, body.username);
      if (!rate.ok) {
        throw new ApiError(429, "Terlalu banyak percobaan login. Coba lagi dalam 1 menit.");
      }

      const [row] = await db
        .select({ id: users.id, username: users.username, name: users.name, passwordHash: users.passwordHash })
        .from(users)
        .where(sql`lower(${users.username}) = ${body.username.trim().toLowerCase()}`)
        .limit(1);

      const valid = !!row && (await Bun.password.verify(body.password, row.passwordHash));
      if (!valid) {
        await logAudit(null, "auth.login-failed", "users", undefined, {
          username: body.username.trim(),
          ip,
        });
        throw new ApiError(401, "Username atau password salah");
      }

      await clearLoginRate(ip);
      const token = await createSession(row.id, row.username);
      set.headers["Set-Cookie"] = cookieFor(token, 60 * 60 * 24);
      await logAudit({ id: row.id, username: row.username }, "login", "users", row.id);
      return { username: row.username, name: row.name };
    },
    { body: loginSchema },
  )
  .post("/logout", async ({ cookie, set, user }) => {
    const token = (cookie[COOKIE_NAME]?.value ?? "") as string;
    await destroySession(token);
    if (user) await logAudit({ id: user.id, username: user.username }, "logout", "users", user.id);
    set.headers["Set-Cookie"] = clearCookie();
    return { ok: true };
  })
  .post(
    "/change-password",
    async ({ body, user, authed }) => {
      if (!authed || !user) throw new ApiError(401, "Belum login");
      const [row] = await db
        .select({ passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.id, user.id))
        .limit(1);
      if (!row || !(await Bun.password.verify(body.currentPassword, row.passwordHash))) {
        throw new ApiError(400, "Password saat ini salah");
      }
      const hash = await Bun.password.hash(body.newPassword, { algorithm: "argon2id" });
      await db.update(users).set({ passwordHash: hash, updatedAt: sql`now()` }).where(eq(users.id, user.id));
      await logAudit({ id: user.id, username: user.username }, "auth.change-password", "users", user.id);
      return { ok: true };
    },
    { body: changePasswordSchema },
  )
  .get("/me", ({ user, authed }) => {
    if (!authed || !user) throw new ApiError(401, "Belum login");
    return { username: user.username, name: user.name, permissions: user.permissions };
  });
