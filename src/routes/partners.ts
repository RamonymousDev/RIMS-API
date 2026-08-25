import { and, asc, count, eq, ilike, or, sql } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { db } from "../db/client";
import { businessPartners, transactions } from "../db/schema";
import { ApiError, assertUuid } from "../http";
import { authGuard, requirePerm } from "../security";
import { logAudit } from "../audit";
import { publishEvent } from "../redis";

const partnerSchema = t.Object({
  code: t.String({ minLength: 1, maxLength: 20 }),
  name: t.String({ minLength: 1, maxLength: 200 }),
  type: t.Optional(t.Union([t.Literal("customer"), t.Literal("supplier"), t.Literal("both")])),
  person: t.Optional(t.String({ maxLength: 100 })),
  phone: t.Optional(t.String({ maxLength: 30 })),
  email: t.Optional(t.String({ maxLength: 100 })),
  address: t.Optional(t.String({ maxLength: 300 })),
  note: t.Optional(t.String({ maxLength: 500 })),
});

const patchPartnerSchema = t.Object({
  code: t.Optional(t.String({ minLength: 1, maxLength: 20 })),
  name: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
  type: t.Optional(t.Union([t.Literal("customer"), t.Literal("supplier"), t.Literal("both")])),
  person: t.Optional(t.Nullable(t.String({ maxLength: 100 }))),
  phone: t.Optional(t.Nullable(t.String({ maxLength: 30 }))),
  email: t.Optional(t.Nullable(t.String({ maxLength: 100 }))),
  address: t.Optional(t.Nullable(t.String({ maxLength: 300 }))),
  note: t.Optional(t.Nullable(t.String({ maxLength: 500 }))),
});

const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === UNIQUE_VIOLATION
  );
}

function partnerSearch(search: string) {
  const q = `%${search}%`;
  return or(
    ilike(businessPartners.name, q),
    ilike(businessPartners.code, q),
    ilike(businessPartners.person, q),
    ilike(businessPartners.phone, q),
    ilike(businessPartners.email, q),
  );
}

function partnerTypeOf(type: string | undefined): "customer" | "supplier" | "both" | undefined {
  return type === "customer" || type === "supplier" || type === "both" ? type : undefined;
}

export const partnerRoutes = new Elysia({ prefix: "/api/partners" }).use(authGuard())
  .get(
    "/",
    async ({ query, user }) => {
      requirePerm(user, "partners:view");
      const page = Math.max(1, Number(query.page ?? "1"));
      const limit = Math.min(100, Math.max(1, Number(query.limit ?? "20")));
      const search = query.search?.trim() ?? "";
      const type = partnerTypeOf(query.type);

      const conditions = [];
      if (search) conditions.push(partnerSearch(search));
      if (type) conditions.push(eq(businessPartners.type, type));

      const [totalRow] = await db
        .select({ n: count() })
        .from(businessPartners)
        .where(conditions.length ? and(...conditions) : undefined);
      const total = totalRow?.n ?? 0;

      const rows = await db
        .select()
        .from(businessPartners)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(asc(businessPartners.name), asc(businessPartners.code))
        .limit(limit)
        .offset((page - 1) * limit);

      return { data: rows, total, page, limit };
    },
    {
      query: t.Object({
        page: t.Optional(t.String()),
        limit: t.Optional(t.String()),
        search: t.Optional(t.String()),
        type: t.Optional(t.String()),
      }),
    },
  )
  .get(
    "/options",
    async ({ query, user }) => {
      requirePerm(user, "partners:view");
      const search = query.search?.trim() ?? "";
      const type = partnerTypeOf(query.type);
      const limit = Math.min(200, Math.max(1, Number(query.limit ?? "50")));

      const conditions = [];
      if (search) conditions.push(partnerSearch(search));
      if (type) conditions.push(eq(businessPartners.type, type));

      const rows = await db
        .select({
          id: businessPartners.id,
          code: businessPartners.code,
          name: businessPartners.name,
          type: businessPartners.type,
        })
        .from(businessPartners)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(asc(businessPartners.name))
        .limit(limit);

      return { data: rows };
    },
    { query: t.Object({ search: t.Optional(t.String()), type: t.Optional(t.String()), limit: t.Optional(t.String()) }) },
  )
  .post(
    "/",
    async ({ body, set, user }) => {
      requirePerm(user, "partners:create");
      try {
        const [created] = await db
          .insert(businessPartners)
          .values({
            code: body.code.trim().toUpperCase(),
            name: body.name.trim(),
            type: body.type ?? "customer",
            person: body.person?.trim() || null,
            phone: body.phone?.trim() || null,
            email: body.email?.trim() || null,
            address: body.address?.trim() || null,
            note: body.note?.trim() || null,
          })
          .returning();
        if (!created) throw new ApiError(500, "Gagal membuat mitra");
        set.status = 201;
        await logAudit(user, "partners.create", "partners", created.id, { code: created.code, name: created.name });
        await publishEvent({ kind: "partner:updated", data: { id: created.id } });
        return { partner: created };
      } catch (err) {
        if (isUniqueViolation(err)) throw new ApiError(409, "Kode sudah digunakan");
        throw err;
      }
    },
    { body: partnerSchema },
  )
  .patch(
    "/:id",
    async ({ params, body, user }) => {
      requirePerm(user, "partners:edit");
      assertUuid(params.id, "Mitra tidak ditemukan");
      try {
        const [updated] = await db
          .update(businessPartners)
          .set({
            ...body,
            code: body.code ? body.code.trim().toUpperCase() : undefined,
            name: body.name ? body.name.trim() : undefined,
            updatedAt: sql`now()`,
          })
          .where(eq(businessPartners.id, params.id))
          .returning();
        if (!updated) throw new ApiError(404, "Mitra tidak ditemukan");
        await logAudit(user, "partners.edit", "partners", updated.id, { code: updated.code });
        await publishEvent({ kind: "partner:updated", data: { id: updated.id } });
        return { partner: updated };
      } catch (err) {
        if (isUniqueViolation(err)) throw new ApiError(409, "Kode sudah digunakan");
        throw err;
      }
    },
    { body: patchPartnerSchema, params: t.Object({ id: t.String() }) },
  )
  .delete(
    "/:id",
    async ({ params, user }) => {
      requirePerm(user, "partners:delete");
      assertUuid(params.id, "Mitra tidak ditemukan");
      const [hasHistory] = await db
        .select({ n: count() })
        .from(transactions)
        .where(eq(transactions.partnerId, params.id));
      if ((hasHistory?.n ?? 0) > 0) {
        throw new ApiError(409, "Mitra punya riwayat transaksi, tidak bisa dihapus");
      }
      const [deleted] = await db
        .delete(businessPartners)
        .where(eq(businessPartners.id, params.id))
        .returning({ id: businessPartners.id, code: businessPartners.code });
      if (!deleted) throw new ApiError(404, "Mitra tidak ditemukan");
      await logAudit(user, "partners.delete", "partners", deleted.id, { code: deleted.code });
      await publishEvent({ kind: "partner:deleted", data: { id: deleted.id } });
      return { ok: true };
    },
    { params: t.Object({ id: t.String() }) },
  )
  .get(
    "/:id",
    async ({ params, user }) => {
      requirePerm(user, "partners:view");
      assertUuid(params.id, "Mitra tidak ditemukan");
      const [partner] = await db
        .select()
        .from(businessPartners)
        .where(eq(businessPartners.id, params.id))
        .limit(1);
      if (!partner) throw new ApiError(404, "Mitra tidak ditemukan");
      return { partner };
    },
    { params: t.Object({ id: t.String() }) },
  );
