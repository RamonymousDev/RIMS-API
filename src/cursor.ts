import { and, eq, lt, or, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

/**
 * Cursor pagination generik: encode/decode `|`-separated key parts dan
 * membangun kondisi "lebih kecil dari" untuk kolom berurutan
 * (urutan stable: (c0, c1, ..., cn) desc → kondisi lt/eq berprogresif).
 */

export function encodeCursor(parts: (string | number)[]): string {
  return parts.join("|");
}

export function decodeCursor(raw: string | undefined): string[] | null {
  if (!raw) return null;
  const parts = raw.split("|");
  return parts.length >= 1 ? parts : null;
}

export function cursorLessThan(columns: PgColumn[], values: unknown[]): SQL | undefined {
  const n = Math.min(columns.length, values.length);
  if (n === 0) return undefined;
  const clauses: SQL[] = [];
  for (let i = 0; i < n; i++) {
    const prefix: SQL[] = [];
    for (let j = 0; j < i; j++) {
      prefix.push(eq(columns[j]!, values[j]! as never));
    }
    prefix.push(lt(columns[i]!, values[i]! as never));
    clauses.push(and(...prefix) as SQL);
  }
  return or(...clauses);
}
