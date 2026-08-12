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
  return XLSX.write(wb, { type: "buffer" }) as Buffer;
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
