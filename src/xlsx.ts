import * as XLSX from "xlsx";

export function workbookBuffer(sheets: Record<string, unknown[][]>): Buffer {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    if (rows.length > 0) {
      ws["!cols"] = rows[0]!.map((_, i) => ({
        wch: Math.max(
          10,
          Math.min(40, ...rows.slice(0, 200).map((r) => String(r[i] ?? "").length + 2)),
        ),
      }));
    }
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  return XLSX.write(wb, { type: "buffer", cellStyles: true }) as Buffer;
}

// ——— Styled helpers for "menarik" exports ———

const BRAND = {
  navy: "1E3A5F",
  ochre: "C4722E",
  border: "D9DDE3",
  stripe: "F8FAFC",
  dangerBg: "FEE2E2",
  dangerFg: "B91C1C",
  warnBg: "FEF3C7",
  warnFg: "92400E",
  okBg: "DCFCE7",
  okFg: "166534",
  muted: "6B7280",
  white: "FFFFFF",
};

type CellAddr = string;

function addr(c: number, r: number): CellAddr {
  return XLSX.utils.encode_cell({ c, r });
}

function ensureCell(ws: XLSX.WorkSheet, c: number, r: number): XLSX.CellObject {
  const a = addr(c, r);
  if (!ws[a]) ws[a] = { t: "s", v: "" } as XLSX.CellObject;
  return ws[a] as XLSX.CellObject;
}

function styleCell(ws: XLSX.WorkSheet, c: number, r: number, s: Record<string, unknown>) {
  const cell = ensureCell(ws, c, r);
  (cell as unknown as { s: unknown }).s = s;
}

function borderThin(color = BRAND.border): Record<string, unknown> {
  const b = { style: "thin", color: { rgb: color } };
  return { top: b, bottom: b, left: b, right: b };
}

export function applySheetHeaderStyle(ws: XLSX.WorkSheet, headerRow: number, colCount: number) {
  for (let c = 0; c < colCount; c++) {
    styleCell(ws, c, headerRow, {
      fill: { fgColor: { rgb: BRAND.navy } },
      font: { bold: true, color: { rgb: BRAND.white }, sz: 11 },
      alignment: { horizontal: "center", vertical: "center", wrapText: true },
      border: borderThin(),
    });
  }
  ws["!rows"] = ws["!rows"] ?? [];
  (ws["!rows"] as unknown as Array<Record<string, unknown>>)[headerRow] = { hpt: 22 };
}

export function applyTitleStyle(ws: XLSX.WorkSheet, row: number, colCount: number, bg = BRAND.navy) {
  for (let c = 0; c < colCount; c++) {
    styleCell(ws, c, row, {
      fill: { fgColor: { rgb: bg } },
      font: { bold: true, color: { rgb: BRAND.white }, sz: 14 },
      alignment: { horizontal: "center", vertical: "center" },
    });
  }
  (ws["!rows"] as unknown as Array<Record<string, unknown>>)[row] = { hpt: 26 };
}

export function applySubtitleStyle(ws: XLSX.WorkSheet, row: number, colCount: number) {
  for (let c = 0; c < colCount; c++) {
    styleCell(ws, c, row, {
      font: { italic: true, color: { rgb: BRAND.muted }, sz: 9 },
      alignment: { horizontal: "left", vertical: "center" },
      border: borderThin(),
    });
  }
}

export function applyZebraAndBorders(ws: XLSX.WorkSheet, dataStartRow: number, dataEndRow: number, colCount: number) {
  for (let r = dataStartRow; r <= dataEndRow; r++) {
    const isStripe = (r - dataStartRow) % 2 === 1;
    for (let c = 0; c < colCount; c++) {
      const base: Record<string, unknown> = {
        border: borderThin(),
        alignment: { vertical: "center", wrapText: true },
      };
      if (isStripe) base.fill = { fgColor: { rgb: BRAND.stripe } };
      // number columns right-align (Stok/Min)
      if (c === 5 || c === 6) base.alignment = { horizontal: "right", vertical: "center" };
      const existing = (ensureCell(ws, c, r) as unknown as { s?: Record<string, unknown> }).s as Record<string, unknown> | undefined;
      styleCell(ws, c, r, { ...(existing ?? {}), ...base });
    }
  }
}

export function applyKondisiStyle(ws: XLSX.WorkSheet, row: number, col: number, kondisi: string) {
  const map: Record<string, { bg: string; fg: string }> = {
    Habis: { bg: BRAND.dangerBg, fg: BRAND.dangerFg },
    Rendah: { bg: BRAND.warnBg, fg: BRAND.warnFg },
    Aman: { bg: BRAND.okBg, fg: BRAND.okFg },
  };
  const m = map[kondisi];
  if (!m) return;
  styleCell(ws, 7, row, {
    fill: { fgColor: { rgb: m.bg } },
    font: { bold: true, color: { rgb: m.fg }, sz: 10 },
    alignment: { horizontal: "center", vertical: "center" },
    border: borderThin(),
  });
}

export function styledStockBuffer(opts: {
  title: string;
  subtitle: string;
  header: string[];
  rows: unknown[][];
  footerText: string;
  sheetName?: string;
  fileName?: string;
}): Buffer {
  const sheetName = opts.sheetName ?? "Stock";
  const headerRow = 2; // 0:title,1:subtitle,2:header
  const dataStart = 3;
  const allRows: unknown[][] = [
    [opts.title],
    [opts.subtitle],
    opts.header,
    ...opts.rows,
    [opts.footerText],
  ];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(allRows);
  const colCount = opts.header.length;
  const totalRows = allRows.length;
  const dataEnd = totalRows - 2; // last before footer

  // merges for title, subtitle, footer
  ws["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: colCount - 1 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: colCount - 1 } },
    { s: { r: totalRows - 1, c: 0 }, e: { r: totalRows - 1, c: colCount - 1 } },
  ];
  ws["!cols"] = opts.header.map((_, i) => ({
    wch: Math.max(12, Math.min(32, Math.max(...allRows.slice(0, 200).map((r) => String(((r as unknown[]) as unknown[])[i] ?? "").length + 3)))),
  }));
  // narrow SKU a bit wider
  {
    const cols = ws["!cols"] as unknown as Array<{ wch: number }> | undefined;
    if (cols?.[0]) cols[0].wch = 18;
  }

  applyTitleStyle(ws, 0, colCount, BRAND.navy);
  applySubtitleStyle(ws, 1, colCount);
  applySheetHeaderStyle(ws, headerRow, colCount);
  applyZebraAndBorders(ws, dataStart, dataEnd, colCount);
  // kondisi column is index 7 (8th col)
  for (let r = dataStart; r <= dataEnd; r++) {
    const kondisi = String((ws[addr(7, r)] as unknown as { v?: unknown })?.v ?? "");
    applyKondisiStyle(ws, r, 7, kondisi);
  }
  // footer style
  for (let c = 0; c < colCount; c++) {
    styleCell(ws, c, totalRows - 1, {
      fill: { fgColor: { rgb: BRAND.stripe } },
      font: { bold: true, color: { rgb: BRAND.navy }, sz: 10 },
      alignment: { horizontal: "left", vertical: "center" },
      border: { top: { style: "medium", color: { rgb: BRAND.navy } }, bottom: borderThin().bottom, left: borderThin().left, right: borderThin().right } as unknown as Record<string, unknown>,
    });
  }
  // freeze panes below header, autofilter
  (ws as unknown as Record<string, unknown>)["!freeze"] = { xSplit: 0, ySplit: 3, topLeftCell: "A4", activePane: "bottomLeft" };
  ws["!autofilter"] = { ref: `${addr(0, headerRow)}:${addr(colCount - 1, headerRow)}` };

  // row heights
  ws["!rows"] = ws["!rows"] ?? [];
  // already set header/title rows

  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { type: "buffer", cellStyles: true }) as Buffer;
}

export function styledStockAttachment(opts: {
  title: string;
  subtitle: string;
  header: string[];
  rows: unknown[][];
  footerText: string;
  fileName: string;
  sheetName?: string;
}): Response {
  const buf = styledStockBuffer(opts);
  return new Response(buf, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${opts.fileName}"`,
      "Content-Length": String(buf.byteLength),
    },
  });
}

export function xlsxAttachment(sheets: Record<string, unknown[][]>, filename: string): Response {
  const buf = workbookBuffer(sheets);
  return new Response(buf, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(buf.byteLength),
    },
  });
}
