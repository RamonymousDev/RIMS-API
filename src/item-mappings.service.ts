import { and, eq, inArray, or } from "drizzle-orm";
import { db } from "./db/client";
import { items, itemMappings } from "./db/schema";
import { ApiError } from "./http";

type LocationInput = {
  line: string;
  column: number;
  row: number;
  position: "top" | "bottom";
  qty: number;
};

type ResolvedLine = { itemId: string; qty: number };

export async function resolveLocations(locations: LocationInput[]): Promise<ResolvedLine[]> {
  if (locations.length === 0) {
    throw new ApiError(400, "Nota harus memiliki minimal satu barang");
  }

  // Build OR conditions for each location
  const conditions = locations.map((l) =>
    and(
      eq(itemMappings.line, l.line),
      eq(itemMappings.column, l.column),
      eq(itemMappings.row, l.row),
      eq(itemMappings.position, l.position),
    ),
  );

  const rows = await db
    .select({
      line: itemMappings.line,
      column: itemMappings.column,
      row: itemMappings.row,
      position: itemMappings.position,
      itemId: itemMappings.itemId,
      isActive: items.isActive,
      stock: items.stock,
    })
    .from(itemMappings)
    .innerJoin(items, eq(itemMappings.itemId, items.id))
    .where(or(...conditions));

  const map = new Map<string, { itemId: string; isActive: boolean; stock: number }>();
  for (const r of rows) {
    map.set(`${r.line}:${r.column}:${r.row}:${r.position}`, r);
  }

  const result: ResolvedLine[] = [];
  const missing: string[] = [];
  const inactive: string[] = [];

  for (const loc of locations) {
    const key = `${loc.line}:${loc.column}:${loc.row}:${loc.position}`;
    const found = map.get(key);
    if (!found) {
      missing.push(`${loc.line}-${loc.column}-${loc.row} ${loc.position}`);
      continue;
    }
    if (!found.isActive) {
      inactive.push(`${loc.line}-${loc.column}-${loc.row} ${loc.position}`);
      continue;
    }
    result.push({ itemId: found.itemId, qty: loc.qty });
  }

  if (missing.length > 0) {
    throw new ApiError(400, `Lokasi tidak ditemukan: ${missing.join(", ")}`);
  }
  if (inactive.length > 0) {
    throw new ApiError(400, `Barang tidak aktif di lokasi: ${inactive.join(", ")}`);
  }

  return result;
}

export type LocationOption = {
  line: string;
  column: number;
  row: number;
  position: "top" | "bottom";
  itemId: string;
  itemName: string;
  itemSku: string;
  minStock: number;
  stock: number;
  unit: string;
};

export async function getLocationOptions(): Promise<{
  lines: string[];
  locations: LocationOption[];
}> {
  const rows = await db
    .select({
      line: itemMappings.line,
      column: itemMappings.column,
      row: itemMappings.row,
      position: itemMappings.position,
      itemId: items.id,
      itemName: items.name,
      itemSku: items.sku,
      minStock: items.minStock,
      stock: items.stock,
      unit: items.unit,
    })
    .from(itemMappings)
    .innerJoin(items, eq(itemMappings.itemId, items.id))
    .where(eq(items.isActive, true))
    .orderBy(itemMappings.line, itemMappings.column, itemMappings.row, itemMappings.position);

  const lines = [...new Set(rows.map((r) => r.line))].sort();

  return {
    lines,
    locations: rows.map((r) => ({
      line: r.line,
      column: r.column,
      row: r.row,
      position: r.position as "top" | "bottom",
      itemId: r.itemId,
      itemName: r.itemName,
      itemSku: r.itemSku,
      minStock: r.minStock,
      stock: r.stock,
      unit: r.unit,
    })),
  };
}
