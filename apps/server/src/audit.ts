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
  | 'user.password_reset'
  | 'service_account.created'
  | 'service_account.updated'
  | 'service_account.deleted'
  | 'token.created'
  | 'token.revoked'
  | 'token.failed'
  | 'token.request'
  | 'asset.deleted'
  | 'asset_type.deleted';

export type AuditEntry = {
  action: AuditAction;
  actorUserId?: string | null;
  actorServiceAccountId?: string | null;
  targetUserId?: string | null;
  ip?: string | null;
  details?: Record<string, unknown>;
};

type Executor = Pick<Db, 'insert'>;

export async function audit(db: Executor, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    action: entry.action,
    actorUserId: entry.actorUserId ?? null,
    actorServiceAccountId: entry.actorServiceAccountId ?? null,
    targetUserId: entry.targetUserId ?? null,
    ip: entry.ip ?? null,
    details: entry.details ?? {},
  });
}
