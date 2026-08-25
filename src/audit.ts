import { lt } from "drizzle-orm";
import { db } from "./db/client";
import { auditLogs } from "./db/schema";

const AUDIT_RETENTION_DAYS = 90;
const PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 jam

export type AuditActor = { id: string; username: string };

export async function logAudit(
  actor: AuditActor | null | undefined,
  action: string,
  target?: string,
  targetId?: string,
  detail?: unknown,
) {
  try {
    await db.insert(auditLogs).values({
      actorId: actor?.id ?? null,
      actorName: actor?.username ?? "system",
      action,
      target: target ?? null,
      targetId: targetId ?? null,
      detail: detail !== undefined ? JSON.stringify(detail) : null,
    });
  } catch {
    // audit failure must never break the request
  }
}

async function purgeOldAuditLogs() {
  try {
    await db.delete(auditLogs).where(lt(auditLogs.createdAt, new Date(Date.now() - AUDIT_RETENTION_DAYS * 86400000)));
  } catch {
    // purge gagal — coba lagi di interval berikutnya
  }
}

/** Jalankan pembersihan audit berkala (dipanggil sekali saat startup). */
export function startAuditRetention() {
  void purgeOldAuditLogs();
  const timer = setInterval(purgeOldAuditLogs, PURGE_INTERVAL_MS);
  timer.unref?.();
}
