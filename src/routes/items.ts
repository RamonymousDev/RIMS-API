import { and, asc, count, desc, eq, ilike, or, sql } from "drizzle-orm";
import { Elysia, t } from "elysia";
import * as XLSX from "xlsx";
import { db } from "../db/client";
import { businessPartners, items, transactionItems, transactions } from "../db/schema";
import { ApiError } from "../http";
import { publishEvent } from "../redis";
import { authGuard, requirePerm } from "../security";
import { invalidateStatsCache } from "./stats";
import { logAudit } from "../audit";
import { createTransaction } from "../transactions.service";
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

const UNIQUE_VIOLATION = "23505";

const IMPORT_MAX_ROWS = 5000;
const IMPORT_MAX_BYTES = 10 * 1024 * 1024;

type ImportCols = {
  sku: number;
  name: number;
  model: number;
  variant: number;
  unit: number;
  minStock: number;
  initialStock: number;
  status: number;
  tanggal: number;
};

const HEADER_ALIASES: Record<keyof ImportCols, string[]> = {
  sku: ["sku", "kode"],
  name: ["nama", "name", "namabarang"],
  model: ["model"],
  variant: ["varian", "variant"],
  unit: ["satuan", "unit"],
  minStock: ["stokmin", "stokminimum", "minstock"],
  initialStock: ["stokawal", "stockawal", "initialstock"],
  status: ["status", "aktif"],
  tanggal: ["tanggal", "date"],
};

function normHeader(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, "");
}

function findCols(headerRow: unknown[]): ImportCols {
  const map = new Map<string, number>();
  headerRow.forEach((h, i) => {
    const key = normHeader(String(h));
    if (key) map.set(key, i);
  });
  const out = {} as ImportCols;
  for (const key of Object.keys(HEADER_ALIASES) as (keyof ImportCols)[]) {
    let idx = -1;
    for (const alias of HEADER_ALIASES[key]) {
      if (map.has(alias)) {
        idx = map.get(alias)!;
        break;
      }
    }
    out[key] = idx;
  }
  return out;
}

function parseNum(v: unknown): number | null {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

function parseStatus(v: unknown): boolean {
  if (v === null || v === undefined || String(v).trim() === "") return true;
  const s = String(v).trim().toLowerCase();
  return !(s === "0" || s === "false" || s === "nonaktif" || s === "tidak" || s === "no");
}

function parseTanggal(v: unknown): string | null {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  const s = String(v).trim();
  // excel kadang memberi Date object
  if (s.match(/^\d{4}-\d{2}-\d{2}$/)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === UNIQUE_VIOLATION
  );
}

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

      let wb: XLSX.WorkBook;
      try {
        wb = XLSX.read(await file.arrayBuffer(), { type: "buffer" });
      } catch {
        throw new ApiError(400, "File bukan XLSX yang valid");
      }
      const sheetName = wb.SheetNames[0];
      if (!sheetName) throw new ApiError(400, "File kosong — tidak ada sheet data");
      const sheet = wb.Sheets[sheetName];
      if (!sheet) throw new ApiError(400, "File kosong — tidak ada sheet data");

      const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false });
      if (aoa.length < 2) throw new ApiError(400, "File tidak memiliki baris data");
      if (aoa.length - 1 > IMPORT_MAX_ROWS) {
        throw new ApiError(400, `Terlalu banyak baris (maks ${IMPORT_MAX_ROWS})`);
      }

      const cols = findCols(aoa[0]!);
      if (cols.sku < 0 || cols.name < 0) {
        throw new ApiError(400, "Kolom SKU dan Nama wajib ada di baris pertama (header)");
      }

      const mode = query.mode === "overwrite" ? "overwrite" : "skip";
      const importKey = headers["idempotency-key"] ?? null;

      const existing = await db.select({ sku: items.sku, id: items.id }).from(items);
      const skuMap = new Map<string, string>();
      for (const r of existing) skuMap.set(r.sku.toLowerCase(), r.id);
      const seenInFile = new Set<string>();

      const errors: { row: number; message: string }[] = [];
      let created = 0;
      let overwritten = 0;
      let skipped = 0;
      let initialStockQty = 0;
      let maxImportDate = "";
      const initialLines: { itemId: string; qty: number }[] = [];

      for (let i = 1; i < aoa.length; i++) {
        const raw = aoa[i]!;
        if (raw.every((c) => c === null || c === undefined || String(c).trim() === "")) continue;
        const rowNum = i + 1;

        const sku = String(raw[cols.sku] ?? "").trim();
        const name = String(raw[cols.name] ?? "").trim();
        if (!sku || !name) {
          errors.push({ row: rowNum, message: "SKU dan Nama wajib diisi" });
          continue;
        }
        const skuKey = sku.toLowerCase();
        if (seenInFile.has(skuKey)) {
          errors.push({ row: rowNum, message: "SKU duplikat dalam file" });
          continue;
        }
        seenInFile.add(skuKey);

        const model =
          cols.model >= 0 && raw[cols.model] != null && String(raw[cols.model]).trim() !== ""
            ? String(raw[cols.model]).trim()
            : null;
        const variant =
          cols.variant >= 0 && raw[cols.variant] != null && String(raw[cols.variant]).trim() !== ""
            ? String(raw[cols.variant]).trim()
            : null;
        const unit =
          cols.unit >= 0 && raw[cols.unit] != null && String(raw[cols.unit]).trim() !== ""
            ? String(raw[cols.unit]).trim()
            : "pcs";
        const minStock = cols.minStock >= 0 ? parseNum(raw[cols.minStock]) : 0;
        const initialStock = cols.initialStock >= 0 ? parseNum(raw[cols.initialStock]) : 0;
        if (minStock === null || minStock < 0) {
          errors.push({ row: rowNum, message: "Stok Min harus angka ≥ 0" });
          continue;
        }
        if (initialStock === null || initialStock < 0) {
          errors.push({ row: rowNum, message: "Stok Awal harus angka ≥ 0" });
          continue;
        }

        const isActive = cols.status >= 0 ? parseStatus(raw[cols.status]) : true;
        let rowDate: string | null = null;
        if (cols.tanggal >= 0 && raw[cols.tanggal] != null && String(raw[cols.tanggal]).trim() !== "") {
          rowDate = parseTanggal(raw[cols.tanggal]);
          if (!rowDate) {
            errors.push({ row: rowNum, message: "Tanggal tidak valid (format YYYY-MM-DD)" });
            continue;
          }
          const today = todayIso();
          if (rowDate > today) {
            errors.push({ row: rowNum, message: "Tanggal tidak boleh di masa depan" });
            continue;
          }
        }
        if (rowDate) maxImportDate = maxImportDate > rowDate ? maxImportDate : rowDate;

        const existingId = skuMap.get(skuKey);
        if (existingId) {
          if (mode === "skip") {
            skipped++;
            continue;
          }
          try {
            await db
              .update(items)
              .set({
                name,
                model,
                variant,
                unit,
                minStock: Math.floor(minStock),
                isActive,
                updatedAt: sql`now()`,
              })
              .where(eq(items.id, existingId));
            overwritten++;
          } catch {
            errors.push({ row: rowNum, message: "Gagal memperbarui barang" });
          }
          continue;
        }

        try {
          const [ins] = await db
            .insert(items)
            .values({
              sku,
              name,
              model,
              variant,
              unit,
              minStock: Math.floor(minStock),
              stock: 0,
              isActive,
            })
            .returning({ id: items.id });
          if (!ins) throw new Error("insert gagal");
          created++;
          skuMap.set(skuKey, ins.id);
          const init = Math.floor(initialStock);
          if (init > 0) {
            initialLines.push({ itemId: ins.id, qty: init });
            initialStockQty += init;
          }
        } catch (err) {
          if (isUniqueViolation(err)) {
            errors.push({ row: rowNum, message: "SKU sudah digunakan" });
          } else {
            errors.push({ row: rowNum, message: "Gagal menyimpan barang" });
          }
        }
      }

      let notaNumber: string | null = null;
      if (initialLines.length > 0) {
        const res = await createTransaction({
          type: "in",
          date: maxImportDate || todayIso(),
          note: "Import — stok awal",
          lines: initialLines,
          idempotencyKey: importKey ? `import:${importKey}` : undefined,
          allowInactive: true,
        });
        if (!res.replay) notaNumber = res.number;
      }

      if (created > 0) {
        invalidateStatsCache();
        await logAudit(user, "items.import", "items", undefined, {
          created,
          overwritten,
          skipped,
          initialStockQty,
          errors: errors.length,
        });
        await publishEvent({ kind: "item:updated", data: { id: "import", name: "Import barang" } });
      }

      return { created, overwritten, skipped, initialStockQty, notaNumber, errors };
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
        invalidateStatsCache();
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
        invalidateStatsCache();
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
      invalidateStatsCache();
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
