import * as XLSX from "xlsx";
import { eq, sql } from "drizzle-orm";
import { db } from "./db/client";
import { items } from "./db/schema";
import { ApiError } from "./http";
import { createTransaction } from "./transactions.service";
import { isFuture, parseBusinessDate, todayIso } from "./dates";

export const IMPORT_MAX_ROWS = 5000;
export const IMPORT_MAX_BYTES = 10 * 1024 * 1024;

const UNIQUE_VIOLATION = "23505";

export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === UNIQUE_VIOLATION
  );
}

export type ParsedItemRow = {
  rowNum: number;
  sku: string;
  name: string;
  model: string | null;
  variant: string | null;
  unit: string;
  minStock: number;
  initialStock: number;
  isActive: boolean;
  date: string | null;
};

export type RowError = { row: number; message: string };

export type ParsedWorkbook = {
  rows: ParsedItemRow[];
  errors: RowError[];
  maxDate: string;
};

export type ItemImportResult = {
  created: number;
  overwritten: number;
  skipped: number;
  initialStockQty: number;
  notaNumber: string | null;
  errors: RowError[];
};

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
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return parseBusinessDate(s) ? s : null;
  }
  // excel kadang memberi Date object / format lain
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Parse & validasi workbook — murni, tanpa DB. */
export function parseItemWorkbook(buffer: ArrayBuffer): ParsedWorkbook {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, { type: "buffer" });
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

  const rows: ParsedItemRow[] = [];
  const errors: RowError[] = [];
  let maxDate = "";
  const seenInFile = new Set<string>();

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
      const parsed = parseBusinessDate(rowDate);
      if (parsed && isFuture(parsed)) {
        errors.push({ row: rowNum, message: "Tanggal tidak boleh di masa depan" });
        continue;
      }
    }
    if (rowDate) maxDate = maxDate > rowDate ? maxDate : rowDate;

    rows.push({
      rowNum,
      sku,
      name,
      model,
      variant,
      unit,
      minStock: Math.floor(minStock),
      initialStock: Math.floor(initialStock),
      isActive,
      date: rowDate,
    });
  }

  return { rows, errors, maxDate };
}

/** Terapkan baris hasil parse ke DB — termasuk nota stok awal. */
export async function applyItemImport(
  rows: ParsedItemRow[],
  opts: { mode: "skip" | "overwrite"; idempotencyKey?: string | null; maxDate?: string },
): Promise<ItemImportResult> {
  const { mode, idempotencyKey, maxDate } = opts;

  const existing = await db.select({ sku: items.sku, id: items.id }).from(items);
  const skuMap = new Map<string, string>();
  for (const r of existing) skuMap.set(r.sku.toLowerCase(), r.id);

  const errors: RowError[] = [];
  let created = 0;
  let overwritten = 0;
  let skipped = 0;
  let initialStockQty = 0;
  const initialLines: { itemId: string; qty: number }[] = [];

  for (const row of rows) {
    const skuKey = row.sku.toLowerCase();
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
            name: row.name,
            model: row.model,
            variant: row.variant,
            unit: row.unit,
            minStock: row.minStock,
            isActive: row.isActive,
            updatedAt: sql`now()`,
          })
          .where(eq(items.id, existingId));
        overwritten++;
      } catch {
        errors.push({ row: row.rowNum, message: "Gagal memperbarui barang" });
      }
      continue;
    }

    try {
      const [ins] = await db
        .insert(items)
        .values({
          sku: row.sku,
          name: row.name,
          model: row.model,
          variant: row.variant,
          unit: row.unit,
          minStock: row.minStock,
          stock: 0,
          isActive: row.isActive,
        })
        .returning({ id: items.id });
      if (!ins) throw new Error("insert gagal");
      created++;
      skuMap.set(skuKey, ins.id);
      if (row.initialStock > 0) {
        initialLines.push({ itemId: ins.id, qty: row.initialStock });
        initialStockQty += row.initialStock;
      }
    } catch (err) {
      if (isUniqueViolation(err)) {
        errors.push({ row: row.rowNum, message: "SKU sudah digunakan" });
      } else {
        errors.push({ row: row.rowNum, message: "Gagal menyimpan barang" });
      }
    }
  }

  let notaNumber: string | null = null;
  if (initialLines.length > 0) {
    const res = await createTransaction({
      type: "in",
      date: maxDate || todayIso(),
      note: "Import — stok awal",
      lines: initialLines,
      idempotencyKey: idempotencyKey ?? undefined,
      allowInactive: true,
    });
    if (!res.replay) notaNumber = res.number;
  }

  return { created, overwritten, skipped, initialStockQty, notaNumber, errors };
}
