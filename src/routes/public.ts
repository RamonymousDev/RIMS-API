import { Elysia, t } from "elysia";
import { env } from "../env";
import { ApiError } from "../http";
import { getLocationOptions } from "../item-mappings.service";

/**
 * Endpoint public (tanpa login) untuk peta stok gudang.
 *
 * Dilindungi token akses sederhana (`PUBLIC_MAP_TOKEN`) yang dibawa via query
 * param `?token=`. Endpoint read-only dan hanya mengekspos data yang memang
 * ingin dipublikasikan (lokasi rak + stok + SKU); id internal (`itemId`)
 * di-sanitasi agar tidak bocor. Tidak ada data transaksi/harga/pengguna.
 */
export const publicRoutes = new Elysia({ prefix: "/api/public" }).get(
  "/warehouse-map",
  async ({ query }) => {
    if (!env.PUBLIC_MAP_TOKEN) {
      throw new ApiError(401, "Peta gudang belum diaktifkan", "public:disabled");
    }
    if (query.token !== env.PUBLIC_MAP_TOKEN) {
      throw new ApiError(401, "Token akses tidak valid", "public:unauthorized");
    }

    const { lines, locations } = await getLocationOptions();

    return {
      lines,
      locations: locations.map((l) => ({
        line: l.line,
        column: l.column,
        row: l.row,
        position: l.position,
        itemSku: l.itemSku,
        itemName: l.itemName,
        stock: l.stock,
        unit: l.unit,
        minStock: l.minStock,
      })),
    };
  },
  { query: t.Object({ token: t.String() }) },
);
