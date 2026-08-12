import { sql } from "drizzle-orm";
import { db } from "./client";
import { businessPartners, items } from "./schema";
import { createTransaction } from "../transactions.service";
import { ensureAdminUser } from "../auth";

const PARTNERS: {
  code: string;
  name: string;
  type: "customer" | "supplier" | "both";
  person?: string;
  phone?: string;
  email?: string;
}[] = [
  { code: "HCMI", name: "HCMI", type: "customer", person: "Budi", phone: "0812-3456-7890", email: "budi@hcmi.co.id" },
  { code: "PTNUS", name: "PT Nusantara Teknologi", type: "both", person: "Sari", phone: "0811-2222-3333", email: "sari@nusatek.co.id" },
  { code: "SUPDIGI", name: "Distributor Digital Mandiri", type: "supplier", person: "Agus", phone: "0878-1111-2222", email: "agus@ddm.co.id" },
  { code: "TOKOBGT", name: "Toko Berkah Gemilang", type: "customer", phone: "0856-7777-8888" },
];

const SAMPLE: {
  sku: string;
  name: string;
  model?: string;
  variant?: string;
  unit: string;
  minStock: number;
}[] = [
  { sku: "LAP-001", name: "Laptop Workstation", model: "ThinkBook 16", variant: "Intel i7 / 16GB", unit: "unit", minStock: 3 },
  { sku: "MON-002", name: "Monitor 27 inch", model: "UltraSharp", variant: "IPS 1440p", unit: "unit", minStock: 5 },
  { sku: "MOU-003", name: "Mouse Wireless", model: "M350", variant: "Hitam", unit: "pcs", minStock: 10 },
  { sku: "KBD-004", name: "Keyboard Mechanical", model: "K6", variant: "Switch Brown", unit: "pcs", minStock: 8 },
  { sku: "RAM-005", name: "RAM DDR5 16GB", model: "Vengeance", variant: "5600MHz", unit: "pcs", minStock: 12 },
  { sku: "SSD-006", name: "SSD NVMe 1TB", model: "980 Pro", variant: "Gen4", unit: "pcs", minStock: 10 },
  { sku: "PRN-007", name: "Printer Laser", model: "M404dn", variant: "Mono", unit: "unit", minStock: 2 },
  { sku: "AP-008", name: "Access Point WiFi 6", model: "EAP670", variant: "AX5400", unit: "unit", minStock: 4 },
  { sku: "KBT-009", name: "Kabel UTP Cat6", model: "CU CAT6", variant: "Putih 305m", unit: "rol", minStock: 6 },
  { sku: "SWT-010", name: "Switch 24 Port", model: "GS324P", variant: "PoE+", unit: "unit", minStock: 2 },
  { sku: "UPS-011", name: "UPS 1200VA", model: "BX1200", variant: "Standby", unit: "unit", minStock: 3 },
  { sku: "HS-012", name: "Headset USB", model: "H570", variant: "Mono", unit: "pcs", minStock: 6 },
];

const DAYS = 14;
const now = Date.now();

function dayOffset(offset: number): Date {
  const d = new Date(now);
  d.setDate(d.getDate() - offset);
  d.setHours(8 + ((offset * 3) % 9), (offset * 7) % 60, 0, 0);
  return d;
}

function dateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function reset() {
  await db.execute(
    sql`TRUNCATE TABLE audit_logs, transaction_items, transactions, items, business_partners, users, counters RESTART IDENTITY CASCADE`,
  );
  console.log("[seed] data lama dibersihkan.");
}

async function seedItems(): Promise<string[]> {
  const created: string[] = [];
  for (const s of SAMPLE) {
    const [row] = await db
      .insert(items)
      .values({
        sku: s.sku,
        name: s.name,
        model: s.model ?? null,
        variant: s.variant ?? null,
        unit: s.unit,
        minStock: s.minStock,
        stock: 0,
      })
      .returning({ id: items.id });
    created.push(row!.id);
  }
  console.log(`[seed] ${created.length} barang dibuat.`);
  return created;
}

async function seedPartners(): Promise<{ customerIds: string[]; supplierIds: string[] }> {
  const customerIds: string[] = [];
  const supplierIds: string[] = [];
  for (const p of PARTNERS) {
    const [row] = await db
      .insert(businessPartners)
      .values({
        code: p.code,
        name: p.name,
        type: p.type,
        person: p.person ?? null,
        phone: p.phone ?? null,
        email: p.email ?? null,
      })
      .returning({ id: businessPartners.id });
    if (p.type === "customer" || p.type === "both") customerIds.push(row!.id);
    if (p.type === "supplier" || p.type === "both") supplierIds.push(row!.id);
  }
  console.log(`[seed] ${PARTNERS.length} mitra dibuat.`);
  return { customerIds, supplierIds };
}

async function seedTransactions(ids: string[], partners: { customerIds: string[]; supplierIds: string[] }) {
  const allIds: string[] = [];
  const { customerIds, supplierIds } = partners;

  // Fase A: semua barang masuk (bangun stok) — dijamin cukup untuk fase B
  for (let offset = DAYS - 1; offset >= 0; offset--) {
    const inIds = ids.filter((_, i) => (i + offset) % 3 === 0);
    if (inIds.length) {
      const r = await createTransaction({
        type: "in",
        date: dateStr(dayOffset(DAYS - offset)),
        note: `Restock — penerimaan ${DAYS - offset} hari lalu`,
        partnerId: supplierIds[(DAYS - offset) % supplierIds.length] ?? null,
        lines: inIds.map((itemId) => ({ itemId, qty: 5 + (offset % 4) })),
      });
      allIds.push(r.transactionId);
    }
  }

  // Fase B: barang keluar kecil-kecil — stok tiap item minimal 10, aman
  for (let offset = DAYS - 1; offset >= 0; offset--) {
    const outIds = ids.filter((_, i) => (i + offset) % 4 === 1);
    if (outIds.length) {
      const r = await createTransaction({
        type: "out",
        date: dateStr(dayOffset(DAYS - offset)),
        note: `Pengeluaran — pemakaian ${DAYS - offset} hari lalu`,
        partnerId: customerIds[(DAYS - offset) % customerIds.length] ?? null,
        lines: outIds.map((itemId) => ({ itemId, qty: 1 + (offset % 2) })),
      });
      allIds.push(r.transactionId);
    }
  }

  // pancing alert stok minim: beberapa barang dibuat di bawah min_stock (tanpa mengubah stok nyata)
  for (let i = 0; i < Math.min(4, ids.length); i++) {
    await db.execute(
      sql`UPDATE items SET min_stock = stock + 2, updated_at = now() WHERE id = ${ids[i]}`,
    );
  }

  const rows = (await db.execute(
    sql`SELECT (SELECT count(*)::int FROM items) AS items, (SELECT count(*)::int FROM transactions) AS transactions, (SELECT coalesce(sum(stock),0)::int FROM items) AS stock, (SELECT count(*)::int FROM items WHERE stock <= min_stock) AS low`,
  )) as { items: number; transactions: number; stock: number; low: number }[];
  const s = rows[0] ?? { items: 0, transactions: 0, stock: 0, low: 0 };
  console.log(
    `[seed] selesai: ${s.items} barang, ${s.transactions} nota, total stok ${s.stock}, stok minim ${s.low}`,
  );
}

await reset();
await ensureAdminUser();
const itemIds = await seedItems();
const partnerIds = await seedPartners();
await seedTransactions(itemIds, partnerIds);
process.exit(0);
