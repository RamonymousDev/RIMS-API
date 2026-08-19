import { and, count, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { db } from "./db/client";
import { businessPartners, items, transactions, transactionItems } from "./db/schema";
import { formatBusinessDate } from "./dates";
import { listTransactions } from "./transactions.service";
import { subscribeFeed } from "./redis";

export type Period = "7d" | "14d" | "30d" | "90d";

const STATS_CACHE_KEY = "rims:stats:cache";
const STATS_TTL = 15;

export function invalidateStatsCache() {
  Bun.redis.del(STATS_CACHE_KEY).catch(() => {});
}

/**
 * Invariant "mutasi inventori → cache rekap basi" hidup di satu tempat:
 * subscriber atas event channel. Route mutasi tidak perlu tahu apa-apa
 * tentang cache statistik. Jika publish gagal, stale bounded oleh TTL cache.
 */
export function subscribeStatsInvalidation() {
  subscribeFeed((message) => {
    try {
      const ev = JSON.parse(message) as { kind?: string };
      const kind = ev.kind ?? "";
      if (
        kind.startsWith("item:") ||
        kind.startsWith("partner:") ||
        kind === "transaction:created" ||
        kind === "transaction:voided"
      ) {
        invalidateStatsCache();
      }
    } catch {
      /* pesan non-JSON dari feed — abaikan */
    }
  });
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
    .where(and(eq(transactions.type, type), isNull(transactions.voidedAt), gte(transactions.date, formatBusinessDate(since))));
  return { count: row?.n ?? 0, qty: row?.qty ?? 0 };
}

function getPeriodDays(period: Period): number {
  switch (period) {
    case "7d": return 7;
    case "14d": return 14;
    case "30d": return 30;
    case "90d": return 90;
  }
}

async function computeStats(period: Period = "14d") {
  const startToday = new Date();
  startToday.setHours(0, 0, 0, 0);
  const startMonth = new Date(startToday);
  startMonth.setDate(1);
  const periodDays = getPeriodDays(period);
  const startPeriod = new Date(startToday);
  startPeriod.setDate(startToday.getDate() - (periodDays - 1));
  const startPrevPeriod = new Date(startPeriod);
  startPrevPeriod.setDate(startPeriod.getDate() - periodDays);
  const start30 = new Date(startToday);
  start30.setDate(startToday.getDate() - 29);

  const [totalItemsRow] = await db.select({ n: count() }).from(items);
  const [stockRow] = await db
    .select({ total: sql<number>`coalesce(sum(${items.stock}), 0)::int` })
    .from(items);
  const [lowStockRow] = await db
    .select({ n: count() })
    .from(items)
    .where(and(sql`${items.stock} <= ${items.minStock}`, eq(items.isActive, true)));

  const [todayInRow, todayOutRow, monthInRow, monthOutRow] = await Promise.all([
    countQtySince("in", startToday),
    countQtySince("out", startToday),
    countQtySince("in", startMonth),
    countQtySince("out", startMonth),
  ]);

  const [periodInRow, periodOutRow, prevPeriodInRow, prevPeriodOutRow] = await Promise.all([
    countQtySince("in", startPeriod),
    countQtySince("out", startPeriod),
    countQtySince("in", startPrevPeriod),
    countQtySince("out", startPrevPeriod),
  ]);

  const totalStockChange = prevPeriodInRow.qty - prevPeriodOutRow.qty !== 0
    ? ((periodInRow.qty - periodOutRow.qty) - (prevPeriodInRow.qty - prevPeriodOutRow.qty)) /
      Math.abs(prevPeriodInRow.qty - prevPeriodOutRow.qty) * 100
    : 0;
  const monthInChange = prevPeriodInRow.qty !== 0
    ? (periodInRow.qty - prevPeriodInRow.qty) / prevPeriodInRow.qty * 100
    : 0;
  const monthOutChange = prevPeriodOutRow.qty !== 0
    ? (periodOutRow.qty - prevPeriodOutRow.qty) / prevPeriodOutRow.qty * 100
    : 0;

  const seriesRows = await db
    .select({
      day: sql<string>`to_char(${transactions.date}, 'YYYY-MM-DD')`,
      type: transactions.type,
      qty: sql<number>`sum(${transactionItems.qty})::int`,
    })
    .from(transactions)
    .innerJoin(transactionItems, eq(transactionItems.transactionId, transactions.id))
    .where(and(isNull(transactions.voidedAt), gte(transactions.date, formatBusinessDate(startPeriod))))
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
  for (let i = 0; i < periodDays; i++) {
    const d = new Date(startPeriod);
    d.setDate(startPeriod.getDate() + i);
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
    .where(and(sql`${items.stock} <= ${items.minStock}`, eq(items.isActive, true)))
    .orderBy(sql`${items.stock} asc`)
    .limit(5);

  const recent = await listTransactions({ limit: 8 });

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
        .where(and(eq(transactions.type, type), isNull(transactions.voidedAt), gte(transactions.date, formatBusinessDate(start30))))
        .groupBy(businessPartners.id)
        .orderBy(desc(sql`count(${transactions.id})`), desc(sql`sum(${transactionItems.qty})`))
        .limit(5)
    ).map((r) => ({ id: r.id, code: r.code, name: r.name, count: r.count, qty: r.qty }));

  const [topCustomers, topSuppliers] = await Promise.all([topBy("out"), topBy("in")]);

  const topItems = await db
    .select({
      id: items.id,
      name: items.name,
      sku: items.sku,
      qty: sql<number>`coalesce(sum(${transactionItems.qty}), 0)::int`,
      movements: count(transactions.id),
    })
    .from(transactionItems)
    .innerJoin(transactions, eq(transactionItems.transactionId, transactions.id))
    .innerJoin(items, eq(transactionItems.itemId, items.id))
    .where(and(isNull(transactions.voidedAt), gte(transactions.date, formatBusinessDate(startPeriod))))
    .groupBy(items.id)
    .orderBy(desc(sql`count(${transactions.id})`), desc(sql`sum(${transactionItems.qty})`))
    .limit(10);

  const start180 = new Date(startToday);
  start180.setDate(startToday.getDate() - 180);
  const deadStock = await db
    .select({
      id: items.id,
      name: items.name,
      sku: items.sku,
      lastMovement: sql<string | null>`max(${transactions.date})`,
    })
    .from(items)
    .leftJoin(transactionItems, eq(transactionItems.itemId, items.id))
    .leftJoin(transactions, and(
      eq(transactionItems.transactionId, transactions.id),
      isNull(transactions.voidedAt),
    ))
    .where(eq(items.isActive, true))
    .groupBy(items.id)
    .having(sql`max(${transactions.date}) IS NULL OR max(${transactions.date}) < ${formatBusinessDate(start180)}`)
    .orderBy(sql`coalesce(max(${transactions.date}), '1970-01-01') asc`)
    .limit(10);

  return {
    totalItems: totalItemsRow?.n ?? 0,
    totalStock: stockRow?.total ?? 0,
    lowStockCount: lowStockRow?.n ?? 0,
    todayIn: todayInRow,
    todayOut: todayOutRow,
    monthIn: monthInRow,
    monthOut: monthOutRow,
    periodIn: periodInRow,
    periodOut: periodOutRow,
    topCustomers,
    topSuppliers,
    chart,
    lowStock,
    recent,
    period: { from: formatBusinessDate(startPeriod), to: formatBusinessDate(startToday) },
    trend: {
      totalStock: Math.round(totalStockChange * 10) / 10,
      monthIn: Math.round(monthInChange * 10) / 10,
      monthOut: Math.round(monthOutChange * 10) / 10,
    },
    topItems: topItems.map((r) => ({
      id: r.id,
      name: r.name,
      sku: r.sku,
      qty: r.qty,
      movements: r.movements,
    })),
    deadStock: deadStock.map((r) => ({
      id: r.id,
      name: r.name,
      sku: r.sku,
      lastMovement: r.lastMovement,
      daysSince: r.lastMovement
        ? Math.floor((Date.now() - new Date(r.lastMovement).getTime()) / 86400000)
        : 999,
    })),
    asOf: new Date(),
  };
}

export type Stats = Awaited<ReturnType<typeof computeStats>>;

function statsCacheKey(period: Period): string {
  return `${STATS_CACHE_KEY}:${period}`;
}

export async function getStats(period: Period = "14d"): Promise<Stats> {
  const key = statsCacheKey(period);
  const cached = await Bun.redis.get(key);
  if (cached) {
    try {
      return JSON.parse(cached) as Stats;
    } catch {
      /* re-compute */
    }
  }
  const stats = await computeStats(period);
  await Bun.redis.set(key, JSON.stringify(stats), "EX", STATS_TTL).catch(
    () => {},
  );
  return stats;
}
