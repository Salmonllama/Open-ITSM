import type { Db } from './db/client.js';
import { auditLog } from './db/schema.js';

export type AuditAction =
  | 'setup.completed'
  | 'login.succeeded'
  | 'login.failed'
  | 'login.locked'
  | 'logout'
  | 'user.created'
  | 'user.updated'
  | 'user.password_reset';

export type AuditEntry = {
  action: AuditAction;
  actorUserId?: string | null;
  targetUserId?: string | null;
  ip?: string | null;
  details?: Record<string, unknown>;
};

type Executor = Pick<Db, 'insert'>;

export async function audit(db: Executor, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    action: entry.action,
    actorUserId: entry.actorUserId ?? null,
    targetUserId: entry.targetUserId ?? null,
    ip: entry.ip ?? null,
    details: entry.details ?? {},
  });
}
