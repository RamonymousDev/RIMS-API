import { asc, eq } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { db } from "../db/client";
import { items, itemMappings } from "../db/schema";
import { ApiError, assertUuid } from "../http";
import { publishEvent } from "../redis";
import { authGuard, requirePerm } from "../security";
import { logAudit } from "../audit";

const mappingSchema = t.Object({
  line: t.String({ minLength: 1, maxLength: 50 }),
  column: t.Integer({ min: 1 }),
  row: t.Integer({ min: 1 }),
  position: t.Union([t.Literal("top"), t.Literal("bottom")]),
  itemId: t.String(),
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

export const itemMappingRoutes = new Elysia({ prefix: "/api/item-mappings" })
  .use(authGuard())
  .get(
    "/",
    async ({ user }) => {
      requirePerm(user, "items:edit");
      const rows = await db
        .select({
          id: itemMappings.id,
          line: itemMappings.line,
          column: itemMappings.column,
          row: itemMappings.row,
          position: itemMappings.position,
          itemId: itemMappings.itemId,
          itemName: items.name,
          itemSku: items.sku,
          createdAt: itemMappings.createdAt,
        })
        .from(itemMappings)
        .innerJoin(items, eq(itemMappings.itemId, items.id))
        .orderBy(asc(itemMappings.line), asc(itemMappings.column), asc(itemMappings.row), asc(itemMappings.position));
      return { data: rows };
    },
  )
  .post(
    "/",
    async ({ body, set, user }) => {
      requirePerm(user, "items:edit");
      assertUuid(body.itemId, "Barang tidak ditemukan");

      const [item] = await db
        .select({ id: items.id })
        .from(items)
        .where(eq(items.id, body.itemId))
        .limit(1);
      if (!item) throw new ApiError(404, "Barang tidak ditemukan");

      try {
        const [created] = await db
          .insert(itemMappings)
          .values({
            itemId: body.itemId,
            line: body.line.trim(),
            column: body.column,
            row: body.row,
            position: body.position,
          })
          .returning();
        if (!created) throw new ApiError(500, "Gagal membuat mapping");

        set.status = 201;
        await logAudit(user, "item-mappings.create", "item-mappings", created.id, {
          line: created.line,
          column: created.column,
          row: created.row,
          position: created.position,
          itemId: created.itemId,
        });
        await publishEvent({ kind: "item:updated", data: { id: body.itemId, name: "Mapping lokasi" } });
        return { mapping: created };
      } catch (err) {
        if (isUniqueViolation(err)) throw new ApiError(409, "Lokasi sudah digunakan oleh barang lain");
        console.error("[item-mappings] create error", err);
        throw err;
      }
    },
    { body: mappingSchema },
  )
  .delete(
    "/:id",
    async ({ params, user }) => {
      requirePerm(user, "items:edit");
      assertUuid(params.id, "Mapping tidak ditemukan");
      const [deleted] = await db
        .delete(itemMappings)
        .where(eq(itemMappings.id, params.id))
        .returning({ id: itemMappings.id, itemId: itemMappings.itemId });
      if (!deleted) throw new ApiError(404, "Mapping tidak ditemukan");
      await logAudit(user, "item-mappings.delete", "item-mappings", deleted.id, {});
      await publishEvent({ kind: "item:updated", data: { id: deleted.itemId, name: "Mapping lokasi" } });
      return { ok: true };
    },
    { params: t.Object({ id: t.String() }) },
  );
