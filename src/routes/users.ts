import { and, desc, eq, gte, ilike, lt, or, sql } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { db } from "../db/client";
import { auditLogs, users } from "../db/schema";
import { ApiError, assertUuid } from "../http";
import { authGuard, requirePerm } from "../security";
import { destroySession, destroyUserSessions, listUserSessions, sessionBelongsToUser } from "../auth";
import { logAudit } from "../audit";
import { parseBusinessDate } from "../dates";
import { cursorLessThan, decodeCursor, encodeCursor } from "../cursor";
import { fullPermissions } from "../permissions";

const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === UNIQUE_VIOLATION
  );
}

const userCreateSchema = t.Object({
  username: t.String({ minLength: 3, maxLength: 64 }),
  password: t.String({ minLength: 8, maxLength: 256 }),
  name: t.String({ minLength: 1, maxLength: 100 }),
  permissions: t.Optional(t.Record(t.String(), t.Boolean())),
});

const userPatchSchema = t.Object({
  name: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
  password: t.Optional(t.String({ minLength: 8, maxLength: 256 })),
  permissions: t.Optional(t.Record(t.String(), t.Boolean())),
});

const idParam = t.Object({ id: t.String() });

export const userRoutes = new Elysia({ prefix: "/api/users" }).use(authGuard())
  .get(
    "/",
    async ({ user }) => {
      requirePerm(user, "users:view");
      const rows = await db
        .select({
          id: users.id,
          username: users.username,
          name: users.name,
          permissions: users.permissions,
          isBootstrap: users.isBootstrap,
          createdAt: users.createdAt,
        })
        .from(users)
        .orderBy(users.createdAt);
      return { data: rows };
    },
  )
  .post(
    "/",
    async ({ body, set, user }) => {
      requirePerm(user, "users:manage");
      const hash = await Bun.password.hash(body.password, { algorithm: "argon2id" });
      try {
        const [created] = await db
          .insert(users)
          .values({
            username: body.username.trim().toLowerCase(),
            passwordHash: hash,
            name: body.name.trim(),
            permissions: body.permissions ?? {},
          })
          .returning({ id: users.id, username: users.username });
        if (!created) throw new ApiError(500, "Gagal membuat pengguna");
        set.status = 201;
        await logAudit(user, "users.create", "users", created.id, { username: created.username });
        return { user: created };
      } catch (err) {
        if (isUniqueViolation(err)) throw new ApiError(409, "Username sudah digunakan");
        throw err;
      }
    },
    { body: userCreateSchema },
  )
  .patch(
    "/:id",
    async ({ params, body, user }) => {
      requirePerm(user, "users:manage");
      assertUuid(params.id, "Pengguna tidak ditemukan");
      const [target] = await db
        .select({ id: users.id, username: users.username, isBootstrap: users.isBootstrap })
        .from(users)
        .where(eq(users.id, params.id))
        .limit(1);
      if (!target) throw new ApiError(404, "Pengguna tidak ditemukan");

      // admin utama hanya bisa mengubah password/permission miliknya sendiri
      if (
        target.isBootstrap &&
        user.id !== target.id &&
        (body.permissions !== undefined || body.password !== undefined)
      ) {
        throw new ApiError(403, "Admin utama tidak bisa diubah oleh pengguna lain");
      }

      if (
        body.permissions &&
        user.id === target.id &&
        (body.permissions as Record<string, boolean>)["users:manage"] !== true
      ) {
        throw new ApiError(400, "Tidak bisa mencabut akses kelola pengguna pada diri sendiri");
      }

      const patch: Record<string, unknown> = { updatedAt: sql`now()` };
      if (body.name !== undefined) patch.name = body.name.trim();
      if (body.permissions !== undefined) patch.permissions = body.permissions;
      if (body.password !== undefined) {
        patch.passwordHash = await Bun.password.hash(body.password, { algorithm: "argon2id" });
      }

      try {
        const [updated] = await db
          .update(users)
          .set(patch)
          .where(eq(users.id, params.id))
          .returning({ id: users.id, username: users.username });
        if (!updated) throw new ApiError(404, "Pengguna tidak ditemukan");
        if (body.password !== undefined) {
          // password diganti → semua sesi lama user tsb di-revoke
          await destroyUserSessions(updated.id);
        }
        await logAudit(user, "users.edit", "users", updated.id, {
          username: updated.username,
          changed: Object.keys(body),
        });
        return { ok: true };
      } catch (err) {
        if (isUniqueViolation(err)) throw new ApiError(409, "Username sudah digunakan");
        throw err;
      }
    },
    { body: userPatchSchema, params: idParam },
  )
  .delete(
    "/:id",
    async ({ params, user }) => {
      requirePerm(user, "users:manage");
      assertUuid(params.id, "Pengguna tidak ditemukan");
      if (user.id === params.id) throw new ApiError(400, "Tidak bisa menghapus akun sendiri");
      const [target] = await db
        .select({ id: users.id, username: users.username, isBootstrap: users.isBootstrap })
        .from(users)
        .where(eq(users.id, params.id))
        .limit(1);
      if (!target) throw new ApiError(404, "Pengguna tidak ditemukan");
      if (target.isBootstrap) throw new ApiError(400, "Admin utama tidak bisa dihapus");
      await db.delete(users).where(eq(users.id, params.id));
      await destroyUserSessions(params.id);
      await logAudit(user, "users.delete", "users", params.id, { username: target.username });
      return { ok: true };
    },
    { params: idParam },
  )
  .get(
    "/:id/sessions",
    async ({ params, user, sessionToken }) => {
      requirePerm(user, "users:view");
      assertUuid(params.id, "Pengguna tidak ditemukan");
      const [target] = await db
        .select({ id: users.id, username: users.username })
        .from(users)
        .where(eq(users.id, params.id))
        .limit(1);
      if (!target) throw new ApiError(404, "Pengguna tidak ditemukan");
      const sessions = await listUserSessions(params.id);
      return {
        data: sessions.map((s) => ({
          tokenHint: s.token.slice(0, 8) + "…",
          username: s.username,
          createdAt: s.createdAt,
          ttlSeconds: s.ttlSeconds,
          isCurrent: s.token === sessionToken,
        })),
      };
    },
    { params: idParam },
  )
  .delete(
    "/:id/sessions/:token",
    async ({ params, user }) => {
      requirePerm(user, "users:manage");
      assertUuid(params.id, "Pengguna tidak ditemukan");
      const [target] = await db
        .select({ id: users.id, username: users.username })
        .from(users)
        .where(eq(users.id, params.id))
        .limit(1);
      if (!target) throw new ApiError(404, "Pengguna tidak ditemukan");
      if (!(await sessionBelongsToUser(params.token, params.id))) {
        throw new ApiError(404, "Sesi tidak ditemukan");
      }
      await destroySession(params.token);
      await logAudit(user, "users.revoke-session", "users", params.id, {
        username: target.username,
      });
      return { ok: true };
    },
    { params: t.Object({ id: t.String(), token: t.String() }) },
  );

export const auditRoutes = new Elysia({ prefix: "/api/audit" }).use(authGuard()).get(
  "/",
  async ({ query, user }) => {
    requirePerm(user, "users:view");
    const limit = Math.min(200, Math.max(1, Number(query.limit ?? "50")));
    const cursor = (() => {
      const parts = decodeCursor(query.cursor);
      if (!parts || parts.length !== 2) return undefined;
      const d = new Date(parts[0]!);
      return Number.isNaN(d.getTime()) ? undefined : { createdAt: d, id: parts[1]! };
    })();
    const search = query.search?.trim();
    const action = query.action?.trim();

    const conditions = [];
    if (search) {
      const q = `%${search}%`;
      conditions.push(
        or(
          ilike(auditLogs.actorName, q),
          ilike(auditLogs.action, q),
          ilike(auditLogs.target, q),
          ilike(auditLogs.detail, q),
        ),
      );
    }
    if (action) conditions.push(eq(auditLogs.action, action));
    const from = query.from ? parseBusinessDate(query.from) : undefined;
    if (from) conditions.push(gte(auditLogs.createdAt, from));
    const to = query.to ? parseBusinessDate(query.to) : undefined;
    if (to) {
      const end = new Date(to);
      end.setDate(end.getDate() + 1);
      conditions.push(lt(auditLogs.createdAt, end));
    }
    const cursorCond = cursor
      ? cursorLessThan([auditLogs.createdAt, auditLogs.id], [cursor.createdAt, cursor.id])
      : undefined;
    if (cursorCond) conditions.push(cursorCond);

    const rows = await db
      .select({
        id: auditLogs.id,
        actorName: auditLogs.actorName,
        action: auditLogs.action,
        target: auditLogs.target,
        targetId: auditLogs.targetId,
        detail: auditLogs.detail,
        createdAt: auditLogs.createdAt,
      })
      .from(auditLogs)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(limit);

    const nextCursor =
      rows.length === limit
        ? encodeCursor([rows[rows.length - 1]!.createdAt.toISOString(), rows[rows.length - 1]!.id])
        : null;
    return { data: rows, nextCursor };
  },
  {
    query: t.Object({
      limit: t.Optional(t.String()),
      cursor: t.Optional(t.String()),
      search: t.Optional(t.String()),
      action: t.Optional(t.String()),
      from: t.Optional(t.String()),
      to: t.Optional(t.String()),
    }),
  },
);
