/**
 * Tanggal bisnis: string `YYYY-MM-DD` dibaca sebagai tanggal LOKAL
 * (bukan UTC). Satu-satunya rumah untuk aturan parse/format tanggal nota,
 * filter rentang, dan validasi masa depan.
 */

export function parseBusinessDate(raw: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatBusinessDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function todayIso(): string {
  return formatBusinessDate(new Date());
}

/** true bila `d` lebih besar dari tengah malam lokal hari ini */
export function isFuture(d: Date): boolean {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return d.getTime() > today.getTime();
}
