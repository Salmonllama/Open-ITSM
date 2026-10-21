import type { ConsumableAdjustmentKind, LowStockSummary } from '@open-itsm/shared';

export const adjustmentLabels: Record<ConsumableAdjustmentKind, string> = {
  created: 'Starting stock',
  added: 'Added',
  used: 'Used',
  counted: 'Counted',
};

/** `+6`, `−2` (a real minus sign) or `0`. */
export function formatChange(change: number): string {
  if (change > 0) return `+${change}`;
  if (change < 0) return `−${-change}`;
  return '0';
}

/** `HP 89A toner (1 left)`; `none left` reads better than `0 left`. */
function itemLeft(item: { name: string; quantity: number }): string {
  return `${item.name} (${item.quantity === 0 ? 'none' : item.quantity} left)`;
}

/**
 * The notice above the asset list, naming up to three items:
 * `2 consumables are low on stock: HP 89A toner (1 left) and AA batteries (none left).`
 */
export function describeLowStock(summary: LowStockSummary, shown = 3): string {
  const { count, items } = summary;
  const named = items.slice(0, shown).map(itemLeft);
  const rest = count - named.length;
  if (rest > 0) named.push(`${rest} more`);
  const list =
    named.length <= 1 ? (named[0] ?? '') : `${named.slice(0, -1).join(', ')} and ${named.at(-1)}`;
  const subject = count === 1 ? '1 consumable is' : `${count} consumables are`;
  return `${subject} low on stock: ${list}.`;
}
