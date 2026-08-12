import { and, count, desc, eq, gte, sql } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { db } from "../db/client";
import { businessPartners, items, transactions, transactionItems } from "../db/schema";
import { ApiError } from "../http";
import { authGuard, requirePerm } from "../security";
import { dateToStr, listTransactions } from "../transactions.service";

const STATS_CACHE_KEY = "stats:cache";
const STATS_TTL = 15;

export function invalidateStatsCache() {
  Bun.redis.del(STATS_CACHE_KEY).catch(() => {});
}

function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function countQtySince(type: "in" | "out", since: Date) {
  const [row] = await db
    .select({
      n: count(),
      qty: sql<number>`coalesce(sum(${transactionItems.qty}), 0)::int`,
    })
    .from(transactions)
    .innerJoin(transactionItems, eq(transactionItems.transactionId, transactions.id))
    .where(and(eq(transactions.type, type), gte(transactions.date, dateToStr(since))));
  return { count: row?.n ?? 0, qty: row?.qty ?? 0 };
}

async function computeStats() {
  const startToday = new Date();
  startToday.setHours(0, 0, 0, 0);
  const startMonth = new Date(startToday);
  startMonth.setDate(1);
  const start14 = new Date(startToday);
  start14.setDate(startToday.getDate() - 13);
  const start30 = new Date(startToday);
  start30.setDate(startToday.getDate() - 29);

  const [totalItemsRow] = await db.select({ n: count() }).from(items);
  const [stockRow] = await db
    .select({ total: sql<number>`coalesce(sum(${items.stock}), 0)::int` })
    .from(items);
  const [lowStockRow] = await db
    .select({ n: count() })
    .from(items)
    .where(sql`${items.stock} <= ${items.minStock}`);

  const [todayInRow, todayOutRow, monthInRow, monthOutRow] = await Promise.all([
    countQtySince("in", startToday),
    countQtySince("out", startToday),
    countQtySince("in", startMonth),
    countQtySince("out", startMonth),
  ]);

  const seriesRows = await db
    .select({
      day: sql<string>`to_char(${transactions.date}, 'YYYY-MM-DD')`,
      type: transactions.type,
      qty: sql<number>`sum(${transactionItems.qty})::int`,
    })
    .from(transactions)
    .innerJoin(transactionItems, eq(transactionItems.transactionId, transactions.id))
    .where(gte(transactions.date, dateToStr(start14)))
    .groupBy(sql`to_char(${transactions.date}, 'YYYY-MM-DD')`, transactions.type)
    .orderBy(sql`to_char(${transactions.date}, 'YYYY-MM-DD')`);

  const series = new Map<string, { in: number; out: number }>();
  for (const row of seriesRows) {
    const entry = series.get(row.day) ?? { in: 0, out: 0 };
    if (row.type === "in") entry.in = row.qty;
    else entry.out = row.qty;
    series.set(row.day, entry);
  }
  const chart: { day: string; label: string; in: number; out: number }[] = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(start14);
    d.setDate(start14.getDate() + i);
    const key = dateKey(d);
    const entry = series.get(key) ?? { in: 0, out: 0 };
    chart.push({
      day: key,
      label: `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`,
      in: entry.in,
      out: entry.out,
    });
  }

  const lowStock = await db
    .select({
      id: items.id,
      name: items.name,
      sku: items.sku,
      model: items.model,
      variant: items.variant,
      unit: items.unit,
      stock: items.stock,
      minStock: items.minStock,
    })
    .from(items)
    .where(sql`${items.stock} <= ${items.minStock}`)
    .orderBy(sql`${items.stock} asc`)
    .limit(5);

  const recent = await listTransactions({ limit: 8 });

  // Top mitra 30 hari: pelanggan (out) dan supplier (in)
  const topBy = async (type: "in" | "out") =>
    (
      await db
        .select({
          id: businessPartners.id,
          code: businessPartners.code,
          name: businessPartners.name,
          count: sql<number>`count(${transactions.id})::int`,
          qty: sql<number>`coalesce(sum(${transactionItems.qty}), 0)::int`,
        })
        .from(transactions)
        .innerJoin(businessPartners, eq(transactions.partnerId, businessPartners.id))
        .innerJoin(transactionItems, eq(transactionItems.transactionId, transactions.id))
        .where(and(eq(transactions.type, type), gte(transactions.date, dateToStr(start30))))
        .groupBy(businessPartners.id)
        .orderBy(desc(sql`count(${transactions.id})`), desc(sql`sum(${transactionItems.qty})`))
        .limit(5)
    ).map((r) => ({ id: r.id, code: r.code, name: r.name, count: r.count, qty: r.qty }));

  const [topCustomers, topSuppliers] = await Promise.all([topBy("out"), topBy("in")]);

  return {
    totalItems: totalItemsRow?.n ?? 0,
    totalStock: stockRow?.total ?? 0,
    lowStockCount: lowStockRow?.n ?? 0,
    todayIn: todayInRow,
    todayOut: todayOutRow,
    monthIn: monthInRow,
    monthOut: monthOutRow,
    topCustomers,
    topSuppliers,
    chart,
    lowStock,
    recent,
    asOf: new Date(),
  };
}

export type Stats = Awaited<ReturnType<typeof computeStats>>;

export const statsRoutes = new Elysia({ prefix: "/api" }).use(authGuard())
  .get("/stats", async ({ user }) => {
    requirePerm(user, "stats:view");

    const cached = await Bun.redis.get(STATS_CACHE_KEY);
    if (cached) {
      try {
        return JSON.parse(cached) as Stats;
      } catch {
        /* re-compute */
      }
    }
    const stats = await computeStats();
    await Bun.redis.set(STATS_CACHE_KEY, JSON.stringify(stats), "EX", STATS_TTL).catch(
      () => {},
    );
    return stats;
  });
