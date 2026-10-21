import { describe, expect, it } from 'vitest';
import { describeLowStock, formatChange } from './consumables';

const item = (name: string, quantity: number) => ({ id: name, name, quantity });

describe('formatChange', () => {
  it('signs changes with a plus or a real minus', () => {
    expect(formatChange(6)).toBe('+6');
    expect(formatChange(-2)).toBe('−2');
    expect(formatChange(0)).toBe('0');
  });
});

describe('describeLowStock', () => {
  it('names one item', () => {
    expect(describeLowStock({ count: 1, items: [item('HP 89A toner', 1)] })).toBe(
      '1 consumable is low on stock: HP 89A toner (1 left).',
    );
  });

  it('joins two items with and, and says none for zero', () => {
    expect(
      describeLowStock({ count: 2, items: [item('AA batteries', 0), item('Chargers', 2)] }),
    ).toBe('2 consumables are low on stock: AA batteries (none left) and Chargers (2 left).');
  });

  it('names three and counts the rest', () => {
    const items = ['A', 'B', 'C', 'D', 'E'].map((n, i) => item(n, i));
    expect(describeLowStock({ count: 5, items })).toBe(
      '5 consumables are low on stock: A (none left), B (1 left), C (2 left) and 2 more.',
    );
  });
});
