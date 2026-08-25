import { Elysia, t } from "elysia";
import { eq, sql } from "drizzle-orm";
import { clearCookie, cookieFor, createSession, destroySession, listUserSessions } from "../auth";
import { ApiError } from "../http";
import {
  authGuard,
  checkLoginRate,
  checkUsernameRate,
  clearLoginRates,
  getClientIp,
} from "../security";
import { COOKIE_NAME } from "../auth";
import { db } from "../db/client";
import { users } from "../db/schema";
import { logAudit } from "../audit";
import { generateCaptcha, saveCaptcha, validateCaptcha } from "../captcha";

const loginSchema = t.Object({
  username: t.String({ minLength: 1, maxLength: 64 }),
  password: t.String({ minLength: 1, maxLength: 256 }),
  captchaId: t.String({ minLength: 8, maxLength: 64 }),
  captchaAnswer: t.Number(),
});

const changePasswordSchema = t.Object({
  currentPassword: t.String({ minLength: 1, maxLength: 256 }),
  newPassword: t.String({ minLength: 8, maxLength: 256 }),
});

// Timing equalizer: verifikasi argon2 terhadap hash dummy saat user tidak ada,
// supaya latensi respons tidak membocorkan keberadaan username.
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  dummyHashPromise ??= Bun.password.hash("rims-timing-equalizer", { algorithm: "argon2id" });
  return dummyHashPromise;
}

const CAPTCHA_RATE_PREFIX = "rims:rl:captcha:";

async function checkCaptchaRate(ip: string): Promise<boolean> {
  const key = `${CAPTCHA_RATE_PREFIX}${ip}`;
  const count = await Bun.redis.incr(key);
  if (count === 1) await Bun.redis.expire(key, 60);
  else if ((await Bun.redis.ttl(key)) < 0) await Bun.redis.expire(key, 60);
  return count <= 30;
}

async function newChallenge() {
  const c = generateCaptcha();
  await saveCaptcha(c.captchaId, c.answer);
  return { captchaId: c.captchaId, question: c.question, options: c.options };
}

export const authRoutes = new Elysia({ prefix: "/api/auth" }).use(authGuard())
  .get(
    "/captcha",
    async ({ request, server, set }) => {
      const ip = getClientIp(request, server, request.headers);
      if (!(await checkCaptchaRate(ip))) {
        throw new ApiError(429, "Terlalu banyak permintaan. Coba lagi dalam 1 menit.");
      }
      return newChallenge();
    },
  )
  .post(
    "/login",
    async ({ body, set, request, server }) => {
      const ip = getClientIp(request, server, request.headers);

      const rate = await checkLoginRate(ip, body.username);
      if (!rate.ok) {
        throw new ApiError(429, "Terlalu banyak percobaan login. Coba lagi dalam 1 menit.");
      }
      // limit global per akun — tahan brute force terdistribusi lintas IP
      if (!(await checkUsernameRate(body.username))) {
        throw new ApiError(429, "Terlalu banyak percobaan login. Coba lagi dalam 1 menit.");
      }

      const captchaResult = await validateCaptcha(body.captchaId, body.captchaAnswer);
      if (!captchaResult.valid) {
        set.status = 401;
        return {
          error: "Jawaban captcha salah",
          captcha: await newChallenge(),
        };
      }

      const [row] = await db
        .select({ id: users.id, username: users.username, name: users.name, passwordHash: users.passwordHash })
        .from(users)
        .where(sql`lower(${users.username}) = ${body.username.trim().toLowerCase()}`)
        .limit(1);

      const valid = !!row && (await Bun.password.verify(body.password, row.passwordHash));
      if (!valid) {
        if (!row) await Bun.password.verify(body.password, await getDummyHash()).catch(() => false);
        await logAudit(null, "auth.login-failed", "users", undefined, {
          username: body.username.trim(),
          ip,
        });
        set.status = 401;
        return {
          error: "Username atau password salah",
          captcha: await newChallenge(),
        };
      }

      await clearLoginRates(ip, body.username);
      const token = await createSession(row.id, row.username);
      set.headers["Set-Cookie"] = cookieFor(token, 60 * 60 * 24);
      await logAudit({ id: row.id, username: row.username }, "login", "users", row.id);
      return { username: row.username, name: row.name };
    },
    { body: loginSchema },
  )
  .post("/logout-all", async ({ user, authed, sessionToken }) => {
    if (!authed || !user) throw new ApiError(401, "Belum login");
    // revoke semua sesi user KECUALI sesi saat ini
    const sessions = await listUserSessions(user.id);
    for (const s of sessions) {
      if (s.token !== sessionToken) await destroySession(s.token);
    }
    await logAudit({ id: user.id, username: user.username }, "auth.logout-all", "users", user.id);
    return { ok: true };
  })
  .post("/logout", async ({ cookie, set, user }) => {
    const token = (cookie[COOKIE_NAME]?.value ?? "") as string;
    await destroySession(token);
    if (user) await logAudit({ id: user.id, username: user.username }, "logout", "users", user.id);
    set.headers["Set-Cookie"] = clearCookie();
    return { ok: true };
  })
  .post(
    "/change-password",
    async ({ body, user, authed, sessionToken }) => {
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
      // password diganti → cabut semua sesi LAIN; sesi saat ini dipertahankan
      const sessions = await listUserSessions(user.id);
      for (const s of sessions) {
        if (s.token !== sessionToken) await destroySession(s.token);
      }
      await logAudit({ id: user.id, username: user.username }, "auth.change-password", "users", user.id);
      return { ok: true };
    },
    { body: changePasswordSchema },
  )
  .get("/me", ({ user, authed }) => {
    if (!authed || !user) throw new ApiError(401, "Belum login");
    return { id: user.id, username: user.username, name: user.name, permissions: user.permissions };
  });
