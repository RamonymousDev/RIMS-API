import { lt } from "drizzle-orm";
import { db } from "./db/client";
import { auditLogs } from "./db/schema";

const AUDIT_RETENTION_DAYS = 90;

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
    // retensi: buang entri lebih lama dari 90 hari (self-healing, sekali per mutasi)
    await db.delete(auditLogs).where(lt(auditLogs.createdAt, new Date(Date.now() - AUDIT_RETENTION_DAYS * 86400000)));
  } catch {
    // audit failure must never break the request
  }
}
