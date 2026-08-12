import { Elysia, t } from "elysia";
import { ApiError } from "../http";
import { publishEvent } from "../redis";
import { authGuard, requirePerm } from "../security";
import { invalidateStatsCache } from "./stats";
import {
  createTransaction,
  exportTransactions,
  getTransactionDetail,
  listTransactions,
  voidTransaction,
} from "../transactions.service";
import { dateTimeCell, xlsxAttachment } from "../xlsx";
import { logAudit } from "../audit";

const lineSchema = t.Object({
  itemId: t.String(),
  qty: t.Integer({ minValue: 1 }),
});

const createSchema = t.Object({
  type: t.Union([t.Literal("in"), t.Literal("out")]),
  date: t.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
  note: t.Optional(t.Nullable(t.String({ maxLength: 500 }))),
  partnerId: t.Optional(t.Nullable(t.String())),
  items: t.Array(lineSchema, { minItems: 1 }),
});

const idParam = t.Object({ id: t.String() });

function parseCursor(raw?: string): { date: Date; createdAt: Date; id: string } | undefined {
  if (!raw) return undefined;
  const [d, iso, id] = raw.split("|");
  if (!d || !iso || !id) return undefined;
  const date = new Date(`${d}T00:00:00`);
  const createdAt = new Date(iso);
  if (Number.isNaN(date.getTime()) || Number.isNaN(createdAt.getTime())) return undefined;
  return { date, createdAt, id };
}

function toCursor(row: { date: string; createdAt: Date; id: string }): string {
  return `${row.date}|${row.createdAt.toISOString()}|${row.id}`;
}

function parseDate(raw: string | undefined): Date | undefined {
  if (!raw) return undefined;
  const [y, m, d] = raw.split("-").map(Number);
  if (!y || !m || !d || y < 1970 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31) {
    return undefined;
  }
  const date = new Date(y, m - 1, d);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export const transactionRoutes = new Elysia({ prefix: "/api/transactions" }).use(authGuard())
  .get(
    "/",
    async ({ query, user }) => {
      requirePerm(user, "transactions:view");
      const limit = Math.min(50, Math.max(1, Number(query.limit ?? "20")));
      const type = query.type === "in" || query.type === "out" ? query.type : undefined;
      const search = query.search?.trim() || undefined;
      const partnerId = query.partnerId || undefined;
      const from = parseDate(query.from);
      const to = parseDate(query.to);
      const cursor = parseCursor(query.cursor);

      const rows = await listTransactions({ type, search, partnerId, from, to, cursor, limit });
      const nextCursor = rows.length === limit ? toCursor(rows[rows.length - 1]!) : null;

      return { data: rows, nextCursor };
    },
    {
      query: t.Object({
        type: t.Optional(t.String()),
        search: t.Optional(t.String()),
        partnerId: t.Optional(t.String()),
        from: t.Optional(t.String()),
        to: t.Optional(t.String()),
        cursor: t.Optional(t.String()),
        limit: t.Optional(t.String()),
      }),
    },
  )
  .get(
    "/export",
    async ({ query, user }) => {
      requirePerm(user, "transactions:export");
      const type = query.type === "in" || query.type === "out" ? query.type : undefined;
      const search = query.search?.trim() || undefined;
      const partnerId = query.partnerId || undefined;
      const from = parseDate(query.from);
      const to = parseDate(query.to);

      const rows = await exportTransactions({ type, search, partnerId, from, to });
      const date = new Date().toISOString().slice(0, 10);

      const summary: unknown[][] = [
        ["Nomor", "Tanggal", "Tipe", "Kode Mitra", "Mitra", "Catatan", "Jumlah Barang", "Total Unit"],
        ...rows.map((t) => [
          t.number,
          t.date,
          t.type === "in" ? "Masuk" : "Keluar",
          t.partner?.code ?? "",
          t.partner?.name ?? "",
          t.note ?? "",
          t.lines.length,
          t.lines.reduce((s, l) => s + l.qty, 0),
        ]),
      ];

      const detail: unknown[][] = [
        ["Nomor", "SKU", "Nama", "Model", "Varian", "Satuan", "Qty", "Tipe", "Mitra", "Tanggal"],
        ...rows.flatMap((t) =>
          t.lines.map((l) => [
            t.number,
            l.sku,
            l.name,
            l.model ?? "",
            l.variant ?? "",
            l.unit,
            l.qty,
            t.type === "in" ? "Masuk" : "Keluar",
            t.partner ? `${t.partner.code} ${t.partner.name}` : "",
            t.date,
          ]),
        ),
      ];

      return xlsxAttachment({ Transaksi: summary, Detail: detail }, `transaksi-${date}.xlsx`);
    },
    {
      query: t.Object({
        type: t.Optional(t.String()),
        search: t.Optional(t.String()),
        partnerId: t.Optional(t.String()),
        from: t.Optional(t.String()),
        to: t.Optional(t.String()),
      }),
    },
  )
  .post(
    "/",
    async ({ body, set, headers, user }) => {
      requirePerm(user, "transactions:create");
      const idempotencyKey = headers["idempotency-key"] ?? null;

      const result = await createTransaction({
        type: body.type,
        date: body.date,
        note: body.note ?? null,
        partnerId: body.partnerId ?? null,
        lines: body.items,
        idempotencyKey,
      });

      if (result.replay) {
        set.status = 200;
        set.headers["Idempotent-Replay"] = "true";
        return { ...result, replay: true };
      }

      set.status = 201;
      invalidateStatsCache();
      await logAudit(user, "transactions.create", "transactions", result.transactionId, {
        number: result.number,
        type: body.type,
      });
      await publishEvent({
        kind: "transaction:created",
        data: { id: result.transactionId, number: result.number, type: body.type },
      });
      return { ...result, replay: false };
    },
    { body: createSchema },
  )
  .post(
    "/:id/void",
    async ({ params, user }) => {
      requirePerm(user, "transactions:void");
      const result = await voidTransaction(params.id);
      invalidateStatsCache();
      await logAudit(user, "transactions.void", "transactions", params.id, {
        number: result.number,
      });
      await publishEvent({
        kind: "transaction:voided",
        data: { id: params.id, number: result.number },
      });
      return result;
    },
    { params: idParam },
  )
  .get("/:id", async ({ params, user }) => {
    requirePerm(user, "transactions:view");
    return getTransactionDetail(params.id);
  }, { params: idParam });
