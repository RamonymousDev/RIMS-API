import { Elysia } from "elysia";
import { and, count, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { db } from "../db/client";
import { items, transactions, transactionItems, businessPartners } from "../db/schema";
import { ApiError, assertUuid } from "../http";
import { authGuard, requirePerm } from "../security";
import { formatBusinessDate } from "../dates";

// ── Helper: average daily outflow for an item ──────────────────────────────

async function getAvgDailyOutflow(itemId: string, days: number): Promise<number> {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const [row] = await db
    .select({
      qty: sql<number>`coalesce(sum(${transactionItems.qty}), 0)::int`,
    })
    .from(transactions)
    .innerJoin(transactionItems, eq(transactionItems.transactionId, transactions.id))
    .where(
      and(
        eq(transactions.type, "out"),
        eq(transactionItems.itemId, itemId),
        isNull(transactions.voidedAt),
        gte(transactions.date, formatBusinessDate(since))
      )
    );

  return (row?.qty ?? 0) / days;
}

// ── Helper: days until empty ───────────────────────────────────────────────

function daysUntilEmpty(stock: number, avgDaily: number): number | null {
  if (avgDaily <= 0) return null;
  return Math.floor(stock / avgDaily);
}

// ── Helper: trend direction ────────────────────────────────────────────────

async function getItemTrend(itemId: string): Promise<"up" | "down" | "stable"> {
  const now = new Date();
  const recent7 = new Date(now);
  recent7.setDate(now.getDate() - 7);
  const prev7 = new Date(now);
  prev7.setDate(now.getDate() - 14);

  const [recentRow, prevRow] = await Promise.all([
    db
      .select({ qty: sql<number>`coalesce(sum(${transactionItems.qty}), 0)::int` })
      .from(transactions)
      .innerJoin(transactionItems, eq(transactionItems.transactionId, transactions.id))
      .where(
        and(
          eq(transactions.type, "out"),
          eq(transactionItems.itemId, itemId),
          isNull(transactions.voidedAt),
          gte(transactions.date, formatBusinessDate(recent7))
        )
      ),
    db
      .select({ qty: sql<number>`coalesce(sum(${transactionItems.qty}), 0)::int` })
      .from(transactions)
      .innerJoin(transactionItems, eq(transactionItems.transactionId, transactions.id))
      .where(
        and(
          eq(transactions.type, "out"),
          eq(transactionItems.itemId, itemId),
          isNull(transactions.voidedAt),
          gte(transactions.date, formatBusinessDate(prev7))
        )
      ),
  ]);

  const recent = (recentRow[0]?.qty ?? 0) / 7;
  const prev = (prevRow[0]?.qty ?? 0) / 7;

  if (recent > prev * 1.15) return "up";
  if (recent < prev * 0.85) return "down";
  return "stable";
}

// ── Helper: item chart data (last N days) ──────────────────────────────────

async function getItemChart(itemId: string, days: number): Promise<{ date: string; in: number; out: number }[]> {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const rows = await db
    .select({
      day: sql<string>`to_char(${transactions.date}, 'YYYY-MM-DD')`,
      type: transactions.type,
      qty: sql<number>`sum(${transactionItems.qty})::int`,
    })
    .from(transactions)
    .innerJoin(transactionItems, eq(transactionItems.transactionId, transactions.id))
    .where(
      and(
        eq(transactionItems.itemId, itemId),
        isNull(transactions.voidedAt),
        gte(transactions.date, formatBusinessDate(since))
      )
    )
    .groupBy(sql`to_char(${transactions.date}, 'YYYY-MM-DD')`, transactions.type)
    .orderBy(sql`to_char(${transactions.date}, 'YYYY-MM-DD')`);

  const map = new Map<string, { in: number; out: number }>();
  for (const row of rows) {
    const entry = map.get(row.day) ?? { in: 0, out: 0 };
    if (row.type === "in") entry.in = row.qty;
    else entry.out = row.qty;
    map.set(row.day, entry);
  }

  const result: { date: string; in: number; out: number }[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(since);
    d.setDate(since.getDate() + i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const entry = map.get(key) ?? { in: 0, out: 0 };
    result.push({ date: key, in: entry.in, out: entry.out });
  }

  return result;
}

// ── Routes ─────────────────────────────────────────────────────────────────

export const raiRoutes = new Elysia({ prefix: "/api/r-ai" })
  .use(authGuard())

  // GET /api/r-ai/insights — system-wide intelligence
  .get(
    "/insights",
    async ({ user }) => {
      requirePerm(user, "items:view");

      const startToday = new Date();
      startToday.setHours(0, 0, 0, 0);
      const start30 = new Date(startToday);
      start30.setDate(startToday.getDate() - 29);

      // Low stock items with avg daily outflow + days until empty
      const lowStockItems = await db
        .select({
          id: items.id,
          name: items.name,
          sku: items.sku,
          unit: items.unit,
          stock: items.stock,
          minStock: items.minStock,
        })
        .from(items)
        .where(and(sql`${items.stock} <= ${items.minStock}`, eq(items.isActive, true)))
        .orderBy(sql`${items.stock} asc`)
        .limit(10);

      const lowStockWithInsights = await Promise.all(
        lowStockItems.map(async (item) => {
          const avg = await getAvgDailyOutflow(item.id, 14);
          return {
            ...item,
            avgDailyOutflow: Math.round(avg * 10) / 10,
            daysUntilEmpty: daysUntilEmpty(item.stock, avg),
          };
        })
      );

      // Dead stock (no movement in 30 days)
      const deadStock = await db
        .select({
          id: items.id,
          name: items.name,
          sku: items.sku,
          lastMovement: sql<string | null>`max(${transactions.date})`,
        })
        .from(items)
        .leftJoin(transactionItems, eq(transactionItems.itemId, items.id))
        .leftJoin(
          transactions,
          and(eq(transactionItems.transactionId, transactions.id), isNull(transactions.voidedAt))
        )
        .where(eq(items.isActive, true))
        .groupBy(items.id)
        .having(sql`max(${transactions.date}) IS NULL OR max(${transactions.date}) < ${formatBusinessDate(start30)}`)
        .orderBy(sql`coalesce(max(${transactions.date}), '1970-01-01') asc`)
        .limit(10);

      // Top movers (highest turnover in 14 days)
      const topMovers = await db
        .select({
          id: items.id,
          name: items.name,
          sku: items.sku,
          movements: count(transactions.id),
          qty: sql<number>`coalesce(sum(${transactionItems.qty}), 0)::int`,
        })
        .from(transactionItems)
        .innerJoin(transactions, eq(transactionItems.transactionId, transactions.id))
        .innerJoin(items, eq(transactionItems.itemId, items.id))
        .where(
          and(
            isNull(transactions.voidedAt),
            gte(transactions.date, formatBusinessDate(start30))
          )
        )
        .groupBy(items.id)
        .orderBy(desc(sql`count(${transactions.id})`), desc(sql`sum(${transactionItems.qty})`))
        .limit(5);

      // Today's activity comparison
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const yesterday = new Date(today);
      yesterday.setDate(today.getDate() - 1);

      const [todayIn, todayOut, yesterdayIn, yesterdayOut] = await Promise.all([
        db
          .select({ qty: sql<number>`coalesce(sum(${transactionItems.qty}), 0)::int` })
          .from(transactions)
          .innerJoin(transactionItems, eq(transactionItems.transactionId, transactions.id))
          .where(and(eq(transactions.type, "in"), isNull(transactions.voidedAt), gte(transactions.date, formatBusinessDate(today)))),
        db
          .select({ qty: sql<number>`coalesce(sum(${transactionItems.qty}), 0)::int` })
          .from(transactions)
          .innerJoin(transactionItems, eq(transactionItems.transactionId, transactions.id))
          .where(and(eq(transactions.type, "out"), isNull(transactions.voidedAt), gte(transactions.date, formatBusinessDate(today)))),
        db
          .select({ qty: sql<number>`coalesce(sum(${transactionItems.qty}), 0)::int` })
          .from(transactions)
          .innerJoin(transactionItems, eq(transactionItems.transactionId, transactions.id))
          .where(and(eq(transactions.type, "in"), isNull(transactions.voidedAt), gte(transactions.date, formatBusinessDate(yesterday)))),
        db
          .select({ qty: sql<number>`coalesce(sum(${transactionItems.qty}), 0)::int` })
          .from(transactions)
          .innerJoin(transactionItems, eq(transactionItems.transactionId, transactions.id))
          .where(and(eq(transactions.type, "out"), isNull(transactions.voidedAt), gte(transactions.date, formatBusinessDate(yesterday)))),
      ]);

      const todayTotal = (todayIn[0]?.qty ?? 0) + (todayOut[0]?.qty ?? 0);
      const yesterdayTotal = (yesterdayIn[0]?.qty ?? 0) + (yesterdayOut[0]?.qty ?? 0);

      return {
        lowStock: lowStockWithInsights,
        deadStock: deadStock.map((r) => ({
          ...r,
          daysSince: r.lastMovement
            ? Math.floor((Date.now() - new Date(r.lastMovement).getTime()) / 86400000)
            : 999,
        })),
        topMovers,
        todayActivity: {
          total: todayTotal,
          vsYesterday: yesterdayTotal > 0 ? Math.round(((todayTotal - yesterdayTotal) / yesterdayTotal) * 100) : 0,
          in: todayIn[0]?.qty ?? 0,
          out: todayOut[0]?.qty ?? 0,
        },
      };
    }
  )

  // GET /api/r-ai/item/:id/intelligence — per-item analytics
  .get(
    "/item/:id/intelligence",
    async ({ user, params }) => {
      requirePerm(user, "items:view");

      const [item] = await db
        .select()
        .from(items)
        .where(eq(items.id, params.id))
        .limit(1);

      if (!item) {
        return { error: "Item tidak ditemukan" };
      }

      const [avg14, avg30, trend, chart14] = await Promise.all([
        getAvgDailyOutflow(item.id, 14),
        getAvgDailyOutflow(item.id, 30),
        getItemTrend(item.id),
        getItemChart(item.id, 14),
      ]);

      // Last reorder (last "in" transaction for this item)
      const [lastReorder] = await db
        .select({
          date: transactions.date,
          qty: transactionItems.qty,
        })
        .from(transactions)
        .innerJoin(transactionItems, eq(transactionItems.transactionId, transactions.id))
        .where(
          and(
            eq(transactions.type, "in"),
            eq(transactionItems.itemId, item.id),
            isNull(transactions.voidedAt)
          )
        )
        .orderBy(desc(transactions.date))
        .limit(1);

      return {
        item: {
          id: item.id,
          name: item.name,
          sku: item.sku,
          unit: item.unit,
          stock: item.stock,
          minStock: item.minStock,
        },
        analytics: {
          avgDailyOutflow14: Math.round(avg14 * 10) / 10,
          avgDailyOutflow30: Math.round(avg30 * 10) / 10,
          trend,
          daysUntilEmpty: daysUntilEmpty(item.stock, avg14),
          chart: chart14,
          lastReorder: lastReorder
            ? { date: lastReorder.date, qty: lastReorder.qty }
            : null,
        },
      };
    }
  )

  // GET /api/r-ai/partner/:id/intelligence — per-partner analytics
  .get(
    "/partner/:id/intelligence",
    async ({ user, params }) => {
      requirePerm(user, "partners:view");

      const [partner] = await db
        .select()
        .from(businessPartners)
        .where(eq(businessPartners.id, params.id))
        .limit(1);

      if (!partner) {
        return { error: "Mitra tidak ditemukan" };
      }

      const start30 = new Date();
      start30.setDate(start30.getDate() - 29);

      // Transaction stats
      const [txStats] = await db
        .select({
          count: count(transactions.id),
          qty: sql<number>`coalesce(sum(${transactionItems.qty}), 0)::int`,
        })
        .from(transactions)
        .innerJoin(transactionItems, eq(transactionItems.transactionId, transactions.id))
        .where(
          and(
            eq(transactions.partnerId, partner.id),
            isNull(transactions.voidedAt),
            gte(transactions.date, formatBusinessDate(start30))
          )
        );

      // Last transaction
      const [lastTx] = await db
        .select({
          date: transactions.date,
          type: transactions.type,
          number: transactions.number,
        })
        .from(transactions)
        .where(
          and(
            eq(transactions.partnerId, partner.id),
            isNull(transactions.voidedAt)
          )
        )
        .orderBy(desc(transactions.date))
        .limit(1);

      // Top items from this partner
      const topItems = await db
        .select({
          name: items.name,
          qty: sql<number>`sum(${transactionItems.qty})::int`,
        })
        .from(transactions)
        .innerJoin(transactionItems, eq(transactionItems.transactionId, transactions.id))
        .innerJoin(items, eq(transactionItems.itemId, items.id))
        .where(
          and(
            eq(transactions.partnerId, partner.id),
            isNull(transactions.voidedAt),
            gte(transactions.date, formatBusinessDate(start30))
          )
        )
        .groupBy(items.id)
        .orderBy(desc(sql`sum(${transactionItems.qty})`))
        .limit(5);

      // Activity status
      let activityStatus: "active" | "inactive" | "new" = "active";
      if (!lastTx) {
        activityStatus = "new";
      } else {
        const daysSince = Math.floor(
          (Date.now() - new Date(lastTx.date).getTime()) / 86400000
        );
        if (daysSince > 30) activityStatus = "inactive";
      }

      return {
        partner: {
          id: partner.id,
          name: partner.name,
          code: partner.code,
          type: partner.type,
          phone: partner.phone,
          email: partner.email,
        },
        analytics: {
          totalTransactions30d: txStats?.count ?? 0,
          totalQty30d: txStats?.qty ?? 0,
          lastTransaction: lastTx
            ? { date: lastTx.date, type: lastTx.type, number: lastTx.number }
            : null,
          topItems,
          activityStatus,
        },
      };
    }
  );
