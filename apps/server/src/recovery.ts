import { emailSchema } from '@open-itsm/shared';
import { asc, eq } from 'drizzle-orm';
import { audit } from './audit.js';
import { generatePassword, hashPassword } from './auth/password.js';
import { SessionStore } from './auth/sessions.js';
import type { Db } from './db/client.js';
import { users } from './db/schema.js';

export const USAGE = `Open ITSM admin recovery

Usage (on the host):
  docker compose exec app itsm <command>

Commands:
  list-users                      List every account with its role and state
  reset-password <email> [--enable]
                                  Set a new random password for a local account, clear any
                                  lockout and sign it out everywhere. --enable also re-enables
                                  a disabled account. The new password is printed once.
  help                            Show this message
`;

export type CliIo = { out: (line: string) => void; err: (line: string) => void };

/** Runs one recovery command; returns the process exit code. */
export async function runRecovery(
  argv: string[],
  deps: { db: Db; sessionSecret: string },
  io: CliIo,
): Promise<number> {
  const [command, ...rest] = argv;

  if (command === 'list-users') {
    const rows = await deps.db.select().from(users).orderBy(asc(users.email));
    if (rows.length === 0) io.out('No users yet. Finish the setup wizard first.');
    for (const u of rows) {
      const state = u.disabledAt
        ? 'disabled'
        : u.lockedUntil && u.lockedUntil > new Date()
          ? 'locked'
          : 'active';
      io.out(`${u.email}\t${u.role}\t${state}${u.passwordHash ? '' : '\t(no local password)'}`);
    }
    return 0;
  }

  if (command === 'reset-password') {
    const enable = rest.includes('--enable');
    const emailArg = rest.find((a) => !a.startsWith('--'));
    const parsed = emailSchema.safeParse(emailArg ?? '');
    if (!parsed.success) {
      io.err('reset-password needs the account email, e.g. itsm reset-password admin@example.com');
      return 2;
    }
    const email = parsed.data;
    const password = generatePassword();
    const passwordHash = await hashPassword(password);
    const sessions = new SessionStore(deps.db, deps.sessionSecret);

    const result = await deps.db.transaction(async (tx) => {
      const [current] = await tx.select().from(users).where(eq(users.email, email));
      if (!current) return 'not_found' as const;
      if (current.role === 'end_user') return 'end_user' as const;
      await tx
        .update(users)
        .set({
          passwordHash,
          failedLoginCount: 0,
          lockedUntil: null,
          updatedAt: new Date(),
          ...(enable ? { disabledAt: null } : {}),
        })
        .where(eq(users.id, current.id));
      await sessions.revokeAllForUser(current.id, tx);
      await audit(tx, {
        action: 'user.password_reset',
        targetUserId: current.id,
        details: { via: 'cli', enabled: enable && current.disabledAt !== null },
      });
      return { stillDisabled: !enable && current.disabledAt !== null };
    });

    if (result === 'not_found') {
      io.err(`No account with email ${email}. Run "itsm list-users" to see accounts.`);
      return 1;
    }
    if (result === 'end_user') {
      io.err(`${email} is an end-user account; end users do not sign in with a password.`);
      return 1;
    }
    io.out(`New password for ${email}: ${password}`);
    io.out('It is shown only once. Sign in with it, then set a new password on the Users page.');
    if (result.stillDisabled) {
      io.out('Note: this account is disabled. Re-run with --enable to re-enable it.');
    }
    return 0;
  }

  if (command === undefined || command === 'help' || command === '--help') {
    io.out(USAGE);
    return command === undefined ? 2 : 0;
  }

  io.err(`Unknown command "${command}".\n`);
  io.err(USAGE);
  return 2;
}
