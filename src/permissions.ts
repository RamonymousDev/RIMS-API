export const PERMISSIONS = {
  "stats:view": "Lihat Dashboard",
  "items:view": "Lihat Barang",
  "items:create": "Tambah Barang",
  "items:edit": "Edit Barang",
  "items:delete": "Hapus Barang",
  "items:import": "Import Barang",
  "items:export": "Export Barang",
  "transactions:view": "Lihat Transaksi",
  "transactions:create": "Buat Transaksi",
  "transactions:export": "Export Transaksi",
  "partners:view": "Lihat Mitra",
  "partners:create": "Tambah Mitra",
  "partners:edit": "Edit Mitra",
  "partners:delete": "Hapus Mitra",
  "users:view": "Lihat Pengguna",
  "users:manage": "Kelola Pengguna",
} as const;

export type Permission = keyof typeof PERMISSIONS;

export const ALL_PERMISSIONS: Permission[] = Object.keys(PERMISSIONS) as Permission[];

export function fullPermissions(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const p of ALL_PERMISSIONS) out[p] = true;
  return out;
}
