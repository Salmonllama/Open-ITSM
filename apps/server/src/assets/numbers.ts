import { formatAssetNumber } from '@open-itsm/shared';
import { eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { assets, assetTypes } from '../db/schema.js';

type Tx = Pick<Db, 'select' | 'update'>;

/**
 * Takes the next `count` numbers from a type's sequence inside the caller's transaction. The type
 * row is locked, so concurrent callers get different numbers; numbers already used (set by hand,
 * or listed in `reserved`, lowercase) are skipped. Returns undefined when the type does not exist.
 */
export async function takeAssetNumbers(
  tx: Tx,
  typeId: string,
  count: number,
  reserved: ReadonlySet<string> = new Set(),
): Promise<string[] | undefined> {
  const [type] = await tx
    .select({ prefix: assetTypes.prefix, next: assetTypes.nextNumber })
    .from(assetTypes)
    .where(eq(assetTypes.id, typeId))
    .for('update');
  if (!type) return undefined;

  const numbers: string[] = [];
  let next = type.next;
  while (numbers.length < count) {
    const batch = Array.from({ length: count - numbers.length + 10 }, (_, i) =>
      formatAssetNumber(type.prefix, next + i),
    );
    const taken = await tx
      .select({ number: sql<string>`lower(${assets.number})` })
      .from(assets)
      .where(
        inArray(
          sql`lower(${assets.number})`,
          batch.map((n) => n.toLowerCase()),
        ),
      );
    const used = new Set(taken.map((t) => t.number));
    for (const candidate of batch) {
      next += 1;
      const lower = candidate.toLowerCase();
      if (used.has(lower) || reserved.has(lower)) continue;
      numbers.push(candidate);
      if (numbers.length === count) break;
    }
  }
  await tx.update(assetTypes).set({ nextNumber: next }).where(eq(assetTypes.id, typeId));
  return numbers;
}
