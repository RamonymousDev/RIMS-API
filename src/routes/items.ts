import { and, asc, count, desc, eq, ilike, or, sql } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { db } from "../db/client";
import { businessPartners, items, transactionItems, transactions } from "../db/schema";
import { ApiError } from "../http";
import { publishEvent } from "../redis";
import { authGuard, requirePerm } from "../security";
import { logAudit } from "../audit";
import { applyItemImport, IMPORT_MAX_BYTES, isUniqueViolation, parseItemWorkbook } from "../import-items";
import { xlsxAttachment } from "../xlsx";

const itemSchema = t.Object({
  sku: t.String({ minLength: 1, maxLength: 50 }),
  name: t.String({ minLength: 1, maxLength: 200 }),
  model: t.Optional(t.String({ maxLength: 100 })),
  variant: t.Optional(t.String({ maxLength: 100 })),
  unit: t.Optional(t.String({ minLength: 1, maxLength: 20 })),
  minStock: t.Optional(t.Integer({ min: 0 })),
  isActive: t.Optional(t.Boolean()),
});

const patchItemSchema = t.Object({
  sku: t.Optional(t.String({ minLength: 1, maxLength: 50 })),
  name: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
  model: t.Optional(t.Nullable(t.String({ maxLength: 100 }))),
  variant: t.Optional(t.Nullable(t.String({ maxLength: 100 }))),
  unit: t.Optional(t.String({ minLength: 1, maxLength: 20 })),
  minStock: t.Optional(t.Integer({ min: 0 })),
  isActive: t.Optional(t.Boolean()),
});


export const itemRoutes = new Elysia({ prefix: "/api/items" }).use(authGuard())
  .get(
    "/",
    async ({ query, user }) => {
      requirePerm(user, "items:view");
      const page = Math.max(1, Number(query.page ?? "1"));
      const limit = Math.min(100, Math.max(1, Number(query.limit ?? "20")));
      const search = query.search?.trim() ?? "";
      const active = query.active === "true" ? true : query.active === "false" ? false : undefined;

      const where = and(
        search
          ? or(
              ilike(items.name, `%${search}%`),
              ilike(items.sku, `%${search}%`),
              ilike(items.model, `%${search}%`),
              ilike(items.variant, `%${search}%`),
            )
          : undefined,
        active !== undefined ? eq(items.isActive, active) : undefined,
      );

      const [totalRow] = await db
        .select({ n: count() })
        .from(items)
        .where(where);
      const total = totalRow?.n ?? 0;

      const rows = await db
        .select({
          id: items.id,
          sku: items.sku,
          name: items.name,
          model: items.model,
          variant: items.variant,
          unit: items.unit,
          minStock: items.minStock,
          stock: items.stock,
          isActive: items.isActive,
          createdAt: items.createdAt,
          updatedAt: items.updatedAt,
        })
        .from(items)
        .where(where)
        .orderBy(asc(items.name), asc(items.sku))
        .limit(limit)
        .offset((page - 1) * limit);

      return { data: rows, total, page, limit };
    },
    {
      query: t.Object({
        page: t.Optional(t.String()),
        limit: t.Optional(t.String()),
        search: t.Optional(t.String()),
        active: t.Optional(t.String()),
      }),
    },
  )
  .get(
    "/options",
    async ({ query, user }) => {
      requirePerm(user, "items:view");
      const search = query.search?.trim() ?? "";
      const where = search
        ? or(
            ilike(items.name, `%${search}%`),
            ilike(items.sku, `%${search}%`),
            ilike(items.model, `%${search}%`),
            ilike(items.variant, `%${search}%`),
          )
        : undefined;

      const rows = await db
        .select({
          id: items.id,
          name: items.name,
          sku: items.sku,
          model: items.model,
          variant: items.variant,
          unit: items.unit,
          stock: items.stock,
        })
        .from(items)
        .where(and(where, eq(items.isActive, true)))
        .orderBy(asc(items.name))
        .limit(50);

      return { data: rows };
    },
    { query: t.Object({ search: t.Optional(t.String()) }) },
  )
  .get(
    "/export",
    async ({ user }) => {
      requirePerm(user, "items:export");
      const rows = await db
        .select({
          sku: items.sku,
          name: items.name,
          model: items.model,
          variant: items.variant,
          unit: items.unit,
          stock: items.stock,
          minStock: items.minStock,
        })
        .from(items)
        .orderBy(asc(items.name), asc(items.sku));
      const date = new Date().toISOString().slice(0, 10);
      return xlsxAttachment(
        {
          Barang: [
            ["SKU", "Nama", "Model", "Varian", "Satuan", "Stok", "Stok Min"],
            ...rows.map((r) => [
              r.sku,
              r.name,
              r.model ?? "",
              r.variant ?? "",
              r.unit,
              r.stock,
              r.minStock,
            ]),
          ],
        },
        `barang-${date}.xlsx`,
      );
    },
  )
  .get(
    "/import/template",
    async ({ user }) => {
      requirePerm(user, "items:import");
      return xlsxAttachment(
        {
          Barang: [
            ["SKU", "Nama", "Model", "Varian", "Satuan", "Stok Min", "Stok Awal", "Status", "Tanggal"],
            ["", "", "", "", "", "", "", "", ""],
          ],
          Petunjuk: [
            ["PETUNJUK IMPORT BARANG (sheet ini tidak diimport)"],
            [""],
            ["Kolom WAJIB: SKU, Nama"],
            ["Kolom opsional: Model, Varian, Satuan, Stok Min, Stok Awal, Status, Tanggal"],
            [""],
            ["- Stok Awal hanya berlaku untuk item BARU; dicatat sebagai nota masuk 'Import — stok awal'"],
            ["- Status: kosong/Aktif/ya/1 = aktif, Nonaktif/tidak/0 = nonaktif"],
            ["- Tanggal (YYYY-MM-DD): tanggal nota stok awal; kosong = hari ini; tidak boleh di masa depan"],
            ["- Mode 'lewati duplikat': SKU yang sudah ada dilewati; 'timpa duplikat': data diperbarui (termasuk Status)"],
            ["- Header kolom tidak sensitif huruf besar/kecil"],
            ["- Re-import aman: tidak menggandakan stok"],
            [""],
            ["CONTOH PENGISIAN:"],
            ["SKU", "Nama", "Model", "Varian", "Satuan", "Stok Min", "Stok Awal", "Status", "Tanggal"],
            ["LAP-100", "Laptop Workstation", "ThinkBook 16", "Intel i7 / 16GB", "unit", 3, 10, "Aktif", "2026-08-01"],
          ],
        },
        "template-import-barang.xlsx",
      );
    },
  )
  .post(
    "/import",
    async ({ body, query, headers, user }) => {
      requirePerm(user, "items:import");
      const file = body.file;
      if (!file) throw new ApiError(400, "File tidak ditemukan");

      const parsed = parseItemWorkbook(await file.arrayBuffer());
      const mode = query.mode === "overwrite" ? "overwrite" : "skip";
      const importKey = headers["idempotency-key"] ?? null;

      const result = await applyItemImport(parsed.rows, {
        mode,
        idempotencyKey: importKey,
        maxDate: parsed.maxDate,
      });
      const errors = [...parsed.errors, ...result.errors];

      if (result.created > 0 || result.overwritten > 0) {
        await logAudit(user, "items.import", "items", undefined, {
          created: result.created,
          overwritten: result.overwritten,
          skipped: result.skipped,
          initialStockQty: result.initialStockQty,
          errors: errors.length,
        });
        await publishEvent({ kind: "item:updated", data: { id: "import", name: "Import barang" } });
      }

      return { ...result, errors };
    },
    {
      body: t.Object({ file: t.File({ maxSize: IMPORT_MAX_BYTES }) }),
      query: t.Object({ mode: t.Optional(t.String()) }),
    },
  )
  .post(
    "/",
    async ({ body, set, headers, user }) => {
      requirePerm(user, "items:create");
      const key = headers["idempotency-key"];
      if (key) {
        const [existing] = await db
          .select({ id: items.id })
          .from(items)
          .where(eq(items.idempotencyKey, key))
          .limit(1);
        if (existing) {
          set.status = 200;
          return { replay: true, item: existing };
        }
      }

      try {
        const [created] = await db
          .insert(items)
          .values({
            sku: body.sku,
            name: body.name,
            model: body.model ?? null,
            variant: body.variant ?? null,
            unit: body.unit ?? "pcs",
            minStock: body.minStock ?? 0,
            isActive: body.isActive ?? true,
            idempotencyKey: key ?? null,
            stock: 0,
          })
          .returning();
        set.status = 201;
        if (!created) throw new ApiError(500, "Gagal membuat barang");
        await logAudit(user, "items.create", "items", created.id, { sku: created.sku, name: created.name });
        await publishEvent({ kind: "item:updated", data: { id: created.id, name: created.name } });
        return { replay: false, item: created };
      } catch (err) {
        if (isUniqueViolation(err)) throw new ApiError(409, "SKU sudah digunakan");
        throw err;
      }
    },
    { body: itemSchema },
  )
  .patch(
    "/:id",
    async ({ params, body, set, user }) => {
      requirePerm(user, "items:edit");
      try {
        const [updated] = await db
          .update(items)
          .set({
            ...body,
            updatedAt: sql`now()`,
          })
          .where(eq(items.id, params.id))
          .returning();
        if (!updated) throw new ApiError(404, "Barang tidak ditemukan");
        await logAudit(user, "items.edit", "items", updated.id, { sku: updated.sku });
        await publishEvent({ kind: "item:updated", data: { id: updated.id, name: updated.name } });
        return { item: updated };
      } catch (err) {
        if (isUniqueViolation(err)) throw new ApiError(409, "SKU sudah digunakan");
        throw err;
      }
    },
    { body: patchItemSchema, params: t.Object({ id: t.String() }) },
  )
  .delete(
    "/:id",
    async ({ params, set, user }) => {
      requirePerm(user, "items:delete");
      const [hasHistory] = await db
        .select({ n: count() })
        .from(transactionItems)
        .where(eq(transactionItems.itemId, params.id));
      if ((hasHistory?.n ?? 0) > 0) {
        throw new ApiError(409, "Barang punya riwayat transaksi, tidak bisa dihapus");
      }
      const [deleted] = await db
        .delete(items)
        .where(eq(items.id, params.id))
        .returning({ id: items.id });
      if (!deleted) throw new ApiError(404, "Barang tidak ditemukan");
      await logAudit(user, "items.delete", "items", deleted.id, {});
      await publishEvent({ kind: "item:deleted", data: { id: deleted.id } });
      return { ok: true };
    },
    { params: t.Object({ id: t.String() }) },
  )
  .get(
    "/:id/transactions",
    async ({ params, user }) => {
      requirePerm(user, "items:view");
      const [item] = await db
        .select({ id: items.id, name: items.name, sku: items.sku, stock: items.stock })
        .from(items)
        .where(eq(items.id, params.id))
        .limit(1);
      if (!item) throw new ApiError(404, "Barang tidak ditemukan");

      const rows = await db
        .select({
          transactionId: transactions.id,
          number: transactions.number,
          date: transactions.date,
          type: transactions.type,
          qty: transactionItems.qty,
          voidedAt: transactions.voidedAt,
          note: transactions.note,
          createdAt: transactions.createdAt,
          partnerCode: businessPartners.code,
          partnerName: businessPartners.name,
        })
        .from(transactionItems)
        .innerJoin(transactions, eq(transactionItems.transactionId, transactions.id))
        .leftJoin(businessPartners, eq(transactions.partnerId, businessPartners.id))
        .where(eq(transactionItems.itemId, params.id))
        .orderBy(desc(transactions.date), desc(transactions.createdAt), desc(transactions.id));

      // stok berjalan: mundur dari stok sekarang, hanya nota yang tidak dibatalkan
      let running = item.stock;
      const data = rows.map((r) => {
        if (r.voidedAt) {
          return {
            id: r.transactionId,
            number: r.number,
            date: r.date,
            type: r.type,
            qty: r.qty,
            voidedAt: r.voidedAt,
            note: r.note,
            createdAt: r.createdAt,
            partner: r.partnerCode ? { code: r.partnerCode, name: r.partnerName ?? "" } : null,
            runningStock: null as number | null,
          };
        }
        const delta = r.type === "in" ? r.qty : -r.qty;
        running -= delta;
        return {
          id: r.transactionId,
          number: r.number,
          date: r.date,
          type: r.type,
          qty: r.qty,
          voidedAt: null,
          note: r.note,
          createdAt: r.createdAt,
          partner: r.partnerCode ? { code: r.partnerCode, name: r.partnerName ?? "" } : null,
          runningStock: running,
        };
      });

      return { item, data };
    },
    { params: t.Object({ id: t.String() }) },
  )
  .get(
    "/:id",
    async ({ params, user }) => {
      requirePerm(user, "items:view");
      const [item] = await db.select().from(items).where(eq(items.id, params.id)).limit(1);
      if (!item) throw new ApiError(404, "Barang tidak ditemukan");
      return { item };
    },
    { params: t.Object({ id: t.String() }) },
  );
