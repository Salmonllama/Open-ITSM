import { z } from 'zod';

export const BACKUP_REASONS = ['scheduled', 'manual', 'pre_migration'] as const;
export const backupReasonSchema = z.enum(BACKUP_REASONS);
export type BackupReason = z.infer<typeof backupReasonSchema>;

export const backupFileSchema = z.object({
  name: z.string(),
  reason: backupReasonSchema,
  createdAt: z.iso.datetime(),
  sizeBytes: z.int().nonnegative(),
});
export type BackupFile = z.infer<typeof backupFileSchema>;

export const backupStatusSchema = z.object({
  retentionDays: z.int().min(1),
  lastBackupAt: z.iso.datetime().nullable(),
  lastError: z.string().nullable(),
  lastErrorAt: z.iso.datetime().nullable(),
  backups: z.array(backupFileSchema),
});
export type BackupStatus = z.infer<typeof backupStatusSchema>;
