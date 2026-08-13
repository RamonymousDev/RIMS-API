/**
 * Ledger riwayat item: menghitung stok berjalan dari pergerakan terbaru→terlama.
 * Nota yang dibatalkan (voided) tetap ditampilkan tapi TIDAK menggeser akumulator
 * (pergerakannya sudah dibalik oleh void).
 */

export type ItemMovement = {
  id: string;
  number: string;
  date: string;
  type: "in" | "out";
  qty: number;
  voidedAt: Date | null;
  note: string | null;
  createdAt: Date;
  partner: { code: string; name: string } | null;
};

export type ItemHistoryRow = ItemMovement & { runningStock: number | null };

/** `movements` harus sudah urut newest→oldest. `currentStock` = stok saat ini. */
export function computeItemHistory(
  movements: ItemMovement[],
  currentStock: number,
): ItemHistoryRow[] {
  let running = currentStock;
  return movements.map((m) => {
    if (m.voidedAt) {
      return { ...m, runningStock: null };
    }
    const delta = m.type === "in" ? m.qty : -m.qty;
    running -= delta;
    return { ...m, runningStock: running };
  });
}
