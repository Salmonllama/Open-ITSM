import { describe, expect, it } from 'vitest';
import { toPages } from './labels';

describe('toPages', () => {
  const tags = Array.from({ length: 31 }, (_, i) => i);

  it('prints one tag per label on a roll', () => {
    expect(toPages(tags.slice(0, 3), 'roll')).toEqual([[0], [1], [2]]);
  });

  it('fills Letter sheets 30 at a time and A4 sheets 21 at a time', () => {
    expect(toPages(tags, 'letter').map((p) => p.length)).toEqual([30, 1]);
    expect(toPages(tags, 'a4').map((p) => p.length)).toEqual([21, 10]);
  });

  it('prints nothing for no tags', () => {
    expect(toPages([], 'letter')).toEqual([]);
  });
});
