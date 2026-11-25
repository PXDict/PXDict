// audit_log writer: every admin write action and security events (AGENTS.md §5). Details must never
// contain passwords, tokens, codes or cookies.
import { auditLog } from "../db/schema";
import type { Db } from "../db/client";

export interface AuditEntry {
  /** user.id of the actor; null for the system or an anonymous client. */
  actorUserId: string | null;
  /** Dotted action name, e.g. "user.ban", "invite.create", "auth.sign_in_failures". */
  action: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
  bytesFreed?: number;
}

export function recordAudit(db: Db, entry: AuditEntry): void {
  db.insert(auditLog)
    .values({
      actorUserId: entry.actorUserId,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      detailsJson: entry.details ?? null,
      bytesFreed: entry.bytesFreed ?? null,
    })
    .run();
}
