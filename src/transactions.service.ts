import { and, eq, gte, ilike, inArray, lt, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { db } from "./db/client";
import { businessPartners, counters, items, transactionItems, transactions } from "./db/schema";
import { ApiError } from "./http";

type Tx = Parameters<Parameters<PostgresJsDatabase["transaction"]>[0]>[0];

export type TransactionInput = {
  type: "in" | "out";
  note?: string | null;
  lines: { itemId: string; qty: number }[];
  partnerId?: string | null;
  idempotencyKey?: string | null;
};

const UNIQUE_VIOLATION = "23505";

function todayParts(d = new Date()) {
  return {
    y: d.getFullYear(),
    m: String(d.getMonth() + 1).padStart(2, "0"),
    day: String(d.getDate()).padStart(2, "0"),
  };
}

export function makeTransactionNumber(seq: number, d = new Date()): string {
  const { y, m, day } = todayParts(d);
  return `TRX-${y}${m}${day}-${String(seq).padStart(4, "0")}`;
}

function isIdempotencyViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === UNIQUE_VIOLATION &&
    "constraint" in err &&
    (err as { constraint: string }).constraint === "transactions_idempotency_key_idx"
  );
}

async function findTransactionByKey(key: string): Promise<string | null> {
  const [row] = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(eq(transactions.idempotencyKey, key))
    .limit(1);
  return row?.id ?? null;
}

type CreateResult =
  | { replay: true; transactionId: string }
  | { replay: false; transactionId: string; number: string };

export async function createTransaction(input: TransactionInput): Promise<CreateResult> {
  const { type, note, partnerId, idempotencyKey } = input;
  const rawLines = input.lines;

  if (rawLines.length === 0) {
    throw new ApiError(400, "Nota harus memiliki minimal satu barang");
  }

  // partner harus cocok dengan tipe nota: in → supplier/both, out → customer/both
  let partner: { id: string } | null = null;
  if (partnerId) {
    const [p] = await db
      .select({ id: businessPartners.id, type: businessPartners.type })
      .from(businessPartners)
      .where(eq(businessPartners.id, partnerId))
      .limit(1);
    if (!p) throw new ApiError(400, "Mitra tidak ditemukan");
    const ok =
      type === "in" ? p.type === "supplier" || p.type === "both" : p.type === "customer" || p.type === "both";
    if (!ok) {
      throw new ApiError(400, type === "in" ? "Mitra harus ber-tipe Supplier atau Keduanya" : "Mitra harus ber-tipe Pelanggan atau Keduanya");
    }
    partner = { id: p.id };
  }

  // agregasi baris (barang sama digabung)
  const agg = new Map<string, number>();
  for (const line of rawLines) {
    const cur = agg.get(line.itemId) ?? 0;
    agg.set(line.itemId, cur + line.qty);
  }
  const finalLines = [...agg.entries()].map(([itemId, qty]) => ({ itemId, qty }));
  const itemIds = finalLines.map((l) => l.itemId);

  // 1. fast-path idempotensi (sebelum transaksi)
  if (idempotencyKey) {
    const existingId = await findTransactionByKey(idempotencyKey);
    if (existingId) return { replay: true, transactionId: existingId };
  }

  try {
    const result = await db.transaction(async (tx) => {
      // 2. kunci semua baris item, diurutkan utk hindari deadlock
      const locked = await tx
        .select({ id: items.id, stock: items.stock })
        .from(items)
        .where(inArray(items.id, itemIds))
        .orderBy(items.id)
        .for("update");

      if (locked.length !== finalLines.length) {
        throw new ApiError(400, "Ada barang yang tidak ditemukan");
      }
      const stockById = new Map(locked.map((i) => [i.id, i.stock]));

      // 3. validasi stok keluar (guard terhadap minus)
      if (type === "out") {
        for (const line of finalLines) {
          if ((stockById.get(line.itemId) ?? 0) < line.qty) {
            throw new ApiError(
              400,
              `Stok tidak mencukupi untuk salah satu barang di nota (barang id: ${line.itemId})`,
            );
          }
        }
      }

      // 4. nomor nota — counter atomik per hari (durable, race-free)
      const { y, m, day } = todayParts();
      const counterKey = `nota:${y}-${m}-${day}`;
      const rows = (await tx.execute(
        sql`
          INSERT INTO counters (key, value) VALUES (${counterKey}, 1)
          ON CONFLICT (key) DO UPDATE SET value = counters.value + 1
          RETURNING value
        `,
      )) as { value: number }[];
      const seq = rows[0]?.value;
      if (!seq) throw new Error("counter gagal");
      const number = makeTransactionNumber(seq);

      // 5. buat nota
      const [trx] = await tx
        .insert(transactions)
        .values({
          number,
          type,
          note: note ?? null,
          partnerId: partner?.id ?? null,
          idempotencyKey: idempotencyKey ?? null,
        })
        .returning();
      if (!trx) throw new Error("nota gagal dibuat");

      // 6. baris nota
      for (const line of finalLines) {
        await tx
          .insert(transactionItems)
          .values({ transactionId: trx.id, itemId: line.itemId, qty: line.qty });
      }

      // 7. geser stok atomically dalam transaksi yg sama
      for (const line of finalLines) {
        const delta = type === "in" ? line.qty : -line.qty;
        await tx
          .update(items)
          .set({ stock: sql`${items.stock} + ${delta}`, updatedAt: sql`now()` })
          .where(eq(items.id, line.itemId));
      }

      return { replay: false, transactionId: trx.id, number };
    });

    return result;
  } catch (err) {
    // 8. race idempotensi: request paralel dgn key sama -> unik constraint
    if (idempotencyKey && isIdempotencyViolation(err)) {
      const existingId = await findTransactionByKey(idempotencyKey);
      if (existingId) return { replay: true, transactionId: existingId };
    }
    throw err;
  }
}

export type TransactionDetail = {
  id: string;
  number: string;
  type: "in" | "out";
  note: string | null;
  partner: { id: string; code: string; name: string; type: string } | null;
  createdAt: Date;
  items: { itemId: string; name: string; sku: string; unit: string; qty: number }[];
};

export async function getTransactionDetail(id: string): Promise<TransactionDetail> {
  const [trx] = await db
    .select({
      id: transactions.id,
      number: transactions.number,
      type: transactions.type,
      note: transactions.note,
      partnerId: transactions.partnerId,
      partnerCode: businessPartners.code,
      partnerName: businessPartners.name,
      partnerType: businessPartners.type,
      createdAt: transactions.createdAt,
    })
    .from(transactions)
    .leftJoin(businessPartners, eq(transactions.partnerId, businessPartners.id))
    .where(eq(transactions.id, id))
    .limit(1);
  if (!trx) throw new ApiError(404, "Nota tidak ditemukan");

  const lines = await db
    .select({
      itemId: items.id,
      name: items.name,
      sku: items.sku,
      unit: items.unit,
      qty: transactionItems.qty,
    })
    .from(transactionItems)
    .innerJoin(items, eq(transactionItems.itemId, items.id))
    .where(eq(transactionItems.transactionId, id))
    .orderBy(transactionItems.id);

  const { partnerId, partnerCode, partnerName, partnerType, ...rest } = trx;
  return {
    ...rest,
    partner:
      partnerId && partnerCode
        ? { id: partnerId, code: partnerCode, name: partnerName ?? "", type: partnerType ?? "" }
        : null,
    items: lines,
  };
}

export type TransactionListFilters = {
  type?: "in" | "out";
  search?: string;
  partnerId?: string;
  from?: Date;
  to?: Date;
};

function transactionFilters(opts: TransactionListFilters) {
  const conditions = [];
  if (opts.type) conditions.push(eq(transactions.type, opts.type));
  if (opts.search) {
    const q = `%${opts.search.trim()}%`;
    conditions.push(or(ilike(transactions.number, q), ilike(transactions.note, q)));
  }
  if (opts.partnerId) conditions.push(eq(transactions.partnerId, opts.partnerId));
  if (opts.from) conditions.push(gte(transactions.createdAt, opts.from));
  if (opts.to) {
    const to = new Date(opts.to);
    to.setDate(to.getDate() + 1);
    conditions.push(lt(transactions.createdAt, to));
  }
  return conditions;
}

export async function listTransactions(opts: TransactionListFilters & {
  cursor?: { createdAt: Date; id: string };
  limit: number;
}) {
  const { cursor, limit } = opts;

  const conditions = transactionFilters(opts);
  if (cursor) {
    conditions.push(
      or(
        lt(transactions.createdAt, cursor.createdAt),
        and(
          eq(transactions.createdAt, cursor.createdAt),
          lt(transactions.id, cursor.id),
        ),
      ),
    );
  }

  const rows = await db
    .select({
      id: transactions.id,
      number: transactions.number,
      type: transactions.type,
      note: transactions.note,
      partnerId: transactions.partnerId,
      partnerCode: businessPartners.code,
      partnerName: businessPartners.name,
      createdAt: transactions.createdAt,
      itemCount: sql<number>`count(${transactionItems.id})::int`,
      totalQty: sql<number>`coalesce(sum(${transactionItems.qty}), 0)::int`,
    })
    .from(transactions)
    .leftJoin(transactionItems, eq(transactionItems.transactionId, transactions.id))
    .leftJoin(businessPartners, eq(transactions.partnerId, businessPartners.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .groupBy(transactions.id, businessPartners.id)
    .orderBy(sql`${transactions.createdAt} desc, ${transactions.id} desc`)
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    type: r.type,
    note: r.note,
    partner: r.partnerId && r.partnerCode ? { id: r.partnerId, code: r.partnerCode, name: r.partnerName ?? "" } : null,
    createdAt: r.createdAt,
    itemCount: r.itemCount,
    totalQty: r.totalQty,
  }));
}

export type ExportTransaction = {
  id: string;
  number: string;
  createdAt: Date;
  type: "in" | "out";
  note: string | null;
  partner: { code: string; name: string } | null;
  lines: {
    sku: string;
    name: string;
    model: string | null;
    variant: string | null;
    unit: string;
    qty: number;
  }[];
};

export async function exportTransactions(opts: TransactionListFilters): Promise<ExportTransaction[]> {
  const conditions = transactionFilters(opts);

  const rows = await db
    .select({
      id: transactions.id,
      number: transactions.number,
      createdAt: transactions.createdAt,
      type: transactions.type,
      note: transactions.note,
      partnerId: transactions.partnerId,
      partnerCode: businessPartners.code,
      partnerName: businessPartners.name,
      sku: items.sku,
      name: items.name,
      model: items.model,
      variant: items.variant,
      unit: items.unit,
      qty: transactionItems.qty,
    })
    .from(transactions)
    .leftJoin(transactionItems, eq(transactionItems.transactionId, transactions.id))
    .leftJoin(items, eq(items.id, transactionItems.itemId))
    .leftJoin(businessPartners, eq(transactions.partnerId, businessPartners.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(sql`${transactions.createdAt} desc, ${transactions.id} desc`);

  const grouped = new Map<string, ExportTransaction>();
  for (const r of rows) {
    let tx = grouped.get(r.id);
    if (!tx) {
      tx = {
        id: r.id,
        number: r.number,
        createdAt: r.createdAt,
        type: r.type,
        note: r.note,
        partner: r.partnerId && r.partnerCode ? { code: r.partnerCode, name: r.partnerName ?? "" } : null,
        lines: [],
      };
      grouped.set(r.id, tx);
    }
    const sku = r.sku;
    if (sku) {
      tx.lines.push({
        sku,
        name: r.name ?? "",
        model: r.model,
        variant: r.variant,
        unit: r.unit ?? "pcs",
        qty: r.qty ?? 0,
      });
    }
  }
  return [...grouped.values()];
}
