import { Elysia, t } from "elysia";
import { authGuard, requirePerm } from "../security";
import { getStats, type Period } from "../stats.service";
import { listTransactions } from "../transactions.service";
import { decodeCursor, encodeCursor } from "../cursor";
import { parseBusinessDate } from "../dates";

export const statsRoutes = new Elysia({ prefix: "/api" }).use(authGuard())
  .get(
    "/stats",
    async ({ user, query }) => {
      requirePerm(user, "stats:view");
      const period = (query.period as Period) || "14d";
      return getStats(period);
    },
    {
      query: t.Object({
        period: t.Optional(t.Union([t.Literal("7d"), t.Literal("14d"), t.Literal("30d"), t.Literal("90d")])),
      }),
    },
  )
  .get(
    "/stats/activity",
    async ({ user, query }) => {
      requirePerm(user, "stats:view");
      const limit = Math.min(50, Math.max(1, Number(query.limit ?? "20")));
      const type = query.type === "in" || query.type === "out" ? query.type : undefined;
      const isVoid = query.type === "void";

      const cursorParts = decodeCursor(query.cursor);
      const cursor = cursorParts && cursorParts.length === 3
        ? {
            date: parseBusinessDate(cursorParts[0]!)!,
            createdAt: new Date(cursorParts[1]!),
            id: cursorParts[2]!,
          }
        : undefined;

      const rows = await listTransactions({
        type: isVoid ? undefined : type,
        search: undefined,
        partnerId: undefined,
        from: undefined,
        to: undefined,
        cursor,
        limit: limit + 1,
      });

      let filtered = rows;
      if (isVoid) {
        filtered = rows.filter((r) => r.voidedAt !== null);
      }

      const hasMore = filtered.length > limit;
      const data = hasMore ? filtered.slice(0, limit) : filtered;
      const nextCursor = hasMore && data.length > 0
        ? encodeCursor([data[data.length - 1]!.date, data[data.length - 1]!.createdAt.toISOString(), data[data.length - 1]!.id])
        : null;

      return { data, nextCursor };
    },
    {
      query: t.Object({
        type: t.Optional(t.String()),
        cursor: t.Optional(t.String()),
        limit: t.Optional(t.String()),
      }),
    },
  );
