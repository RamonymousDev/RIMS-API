import { Elysia, t } from "elysia";
import { ApiError } from "../http";
import { publishEvent } from "../redis";
import { authGuard, requirePerm, checkExportRate, getClientIp } from "../security";
import {
  createTransaction,
  exportTransactions,
  getTransactionDetail,
  listTransactions,
  voidTransaction,
} from "../transactions.service";
import { getLocationOptions, resolveLocations } from "../item-mappings.service";
import { xlsxAttachment } from "../xlsx";
import { formatBusinessDate, parseBusinessDate } from "../dates";
import { cursorLessThan, decodeCursor, encodeCursor } from "../cursor";
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
  const parts = decodeCursor(raw);
  if (!parts || parts.length !== 3) return undefined;
  const date = parseBusinessDate(parts[0]!);
  const createdAt = new Date(parts[1]!);
  if (!date || Number.isNaN(createdAt.getTime())) return undefined;
  return { date, createdAt, id: parts[2]! };
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
      const from = query.from ? (parseBusinessDate(query.from) ?? undefined) : undefined;
      const to = query.to ? (parseBusinessDate(query.to) ?? undefined) : undefined;
      const cursor = parseCursor(query.cursor);

      const rows = await listTransactions({ type, search, partnerId, from, to, cursor, limit });
      const nextCursor = rows.length === limit
        ? encodeCursor([rows[rows.length - 1]!.date, rows[rows.length - 1]!.createdAt.toISOString(), rows[rows.length - 1]!.id])
        : null;

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
    async ({ query, user, request, server }) => {
      requirePerm(user, "transactions:export");
      const ip = getClientIp(request, server, request.headers);
      if (!(await checkExportRate(ip))) {
        throw new ApiError(429, "Terlalu banyak permintaan export. Coba lagi dalam 1 menit.");
      }
      const type = query.type === "in" || query.type === "out" ? query.type : undefined;
      const search = query.search?.trim() || undefined;
      const partnerId = query.partnerId || undefined;
      const from = query.from ? (parseBusinessDate(query.from) ?? undefined) : undefined;
      const to = query.to ? (parseBusinessDate(query.to) ?? undefined) : undefined;

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
  .get(
    "/locations",
    async ({ user }) => {
      requirePerm(user, "transactions:view");
      return getLocationOptions();
    },
  )
  .post(
    "/quick-out",
    async ({ body, set, headers, user }) => {
      requirePerm(user, "transactions:create");
      const idempotencyKey = headers["idempotency-key"] ?? null;

      const resolved = await resolveLocations(body.items);

      const result = await createTransaction({
        type: "out",
        date: body.date,
        note: body.note ?? null,
        partnerId: body.partnerId ?? null,
        lines: resolved,
        idempotencyKey,
      });

      if (result.replay) {
        set.status = 200;
        set.headers["Idempotent-Replay"] = "true";
        return { ...result, replay: true };
      }

      set.status = 201;
      await logAudit(user, "transactions.quick-out", "transactions", result.transactionId, {
        number: result.number,
        itemCount: body.items.length,
      });
      await publishEvent({
        kind: "transaction:created",
        data: { id: result.transactionId, number: result.number, type: "out" },
      });
      return { ...result, replay: false };
    },
    {
      body: t.Object({
        date: t.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
        note: t.Optional(t.Nullable(t.String({ maxLength: 500 }))),
        partnerId: t.Optional(t.Nullable(t.String())),
        items: t.Array(
          t.Object({
            line: t.String(),
            column: t.Integer({ minValue: 1 }),
            row: t.Integer({ minValue: 1 }),
            position: t.Union([t.Literal("top"), t.Literal("bottom")]),
            qty: t.Integer({ minValue: 1 }),
          }),
          { minItems: 1 },
        ),
      }),
    },
  )
  .post(
    "/:id/void",
    async ({ params, user }) => {
      requirePerm(user, "transactions:void");
      const result = await voidTransaction(params.id);
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
