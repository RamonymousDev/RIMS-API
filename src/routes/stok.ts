import { asc, ilike, inArray, or, sql } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { db } from "../db/client";
import { items, itemMappings } from "../db/schema";
import { ApiError } from "../http";
import { authGuard, requirePerm, checkExportRate, getClientIp } from "../security";
import { styledStockAttachment } from "../xlsx";

type StatusFilter = "habis" | "rendah" | "aman";

function stockKondisi(stock: number, minStock: number): string {
  if (stock <= 0) return "Habis";
  if (stock <= minStock) return "Rendah";
  return "Aman";
}

export const stokRoutes = new Elysia({ prefix: "/api/stok" }).use(authGuard())
  .get(
    "/export",
    async ({ query, user, request, server }) => {
      requirePerm(user, "items:export");
      const ip = getClientIp(request, server, request.headers);
      if (!(await checkExportRate(ip))) {
        throw new ApiError(429, "Terlalu banyak permintaan export. Coba lagi dalam 1 menit.");
      }
      const search = query.search?.trim() ?? "";
      const status = (query.status === "habis" || query.status === "rendah" || query.status === "aman" ? query.status : undefined) as StatusFilter | undefined;
      const activeParam = query.active;
      const active = activeParam === "true" ? true : activeParam === "false" ? false : undefined;

      // fetch all matching items (no pagination for export, cap 5000)
      const whereSearch = search
        ? or(
            ilike(items.sku, `%${search}%`),
            ilike(items.name, `%${search}%`),
            ilike(items.model, `%${search}%`),
            ilike(items.variant, `%${search}%`),
          )
        : undefined;
      // active handled in memory to keep query simple, or add to where if needed
      const rows = await db
        .select({
          sku: items.sku,
          name: items.name,
          model: items.model,
          variant: items.variant,
          unit: items.unit,
          stock: items.stock,
          minStock: items.minStock,
          isActive: items.isActive,
          id: items.id,
        })
        .from(items)
        .where(whereSearch ? whereSearch : undefined)
        .orderBy(asc(items.sku));

      // filter active if requested
      let filtered = rows;
      if (active !== undefined) filtered = filtered.filter((r) => r.isActive === active);
      if (status) {
        filtered = filtered.filter((r) => {
          const k = r.stock <= 0 ? "habis" : r.stock <= r.minStock ? "rendah" : "aman";
          return k === status;
        });
      }

      // titik rak count per item
      const ids = filtered.map((r) => r.id);
      let titikMap = new Map<string, number>();
      if (ids.length > 0 && ids.length <= 5000) {
        const mappings = await db
          .select({ itemId: itemMappings.itemId, cnt: sql<number>`count(*)::int` })
          .from(itemMappings)
          .where(inArray(itemMappings.itemId, ids))
          .groupBy(itemMappings.itemId);
        titikMap = new Map(mappings.map((m) => [m.itemId, m.cnt]));
      } else if (ids.length > 5000) {
        // large export: count in memory via full scan (still bounded)
        const all = await db.select({ itemId: itemMappings.itemId }).from(itemMappings);
        const counts = new Map<string, number>();
        for (const a of all) if (ids.includes(a.itemId)) counts.set(a.itemId, (counts.get(a.itemId) ?? 0) + 1);
        titikMap = counts;
      }

      const header = ["SKU", "Nama", "Model", "Varian", "Satuan", "Stok", "Stok Min", "Kondisi", "Titik Rak", "Status"];
      const body: unknown[][] = filtered.map((r) => [
        r.sku,
        r.name,
        r.model ?? "",
        r.variant ?? "",
        r.unit,
        r.stock,
        r.minStock,
        stockKondisi(r.stock, r.minStock),
        titikMap.get(r.id) ?? 0,
        r.isActive ? "Aktif" : "Nonaktif",
      ]);

      const date = new Date().toISOString().slice(0, 10);
      const ts = new Date().toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" });
      const subtitle = `Filter: ${search ? `q="${search}"` : "semua"} | status=${status ?? "semua"}${active !== undefined ? ` | aktif=${active ? "ya" : "tidak"}` : ""} | diekspor ${ts} | ${filtered.length} SKU`;
      const footer = `Total SKU: ${filtered.length} | Total unit: ${filtered.reduce((s, r) => s + r.stock, 0)} | Habis: ${filtered.filter((r) => r.stock <= 0).length} | Rendah: ${filtered.filter((r) => r.stock > 0 && r.stock <= r.minStock).length} | Aman: ${filtered.filter((r) => r.stock > r.minStock).length}`;

      return styledStockAttachment({
        title: "RIMS — Monitoring Stok",
        subtitle,
        header,
        rows: body,
        footerText: footer,
        fileName: `stok-${date}.xlsx`,
        sheetName: "Stock",
      });
    },
    {
      query: t.Object({
        search: t.Optional(t.String()),
        status: t.Optional(t.String()),
        active: t.Optional(t.String()),
      }),
    },
  );
