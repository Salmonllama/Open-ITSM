import type { AssetField } from '@open-itsm/shared';
import { describe, expect, it } from 'vitest';
import { formatFieldValue } from './assets';

const field = (kind: AssetField['kind']): AssetField => ({
  id: '00000000-0000-4000-8000-000000000000',
  key: 'f',
  label: 'F',
  kind,
  options: [],
  required: false,
});

describe('formatFieldValue', () => {
  it('shows a dash for missing values and words for yes/no', () => {
    expect(formatFieldValue(field('text'), undefined)).toBe('—');
    expect(formatFieldValue(field('boolean'), true)).toBe('Yes');
    expect(formatFieldValue(field('boolean'), false)).toBe('No');
  });

  it('reads a stored date as a local calendar date, not a UTC instant', () => {
    expect(formatFieldValue(field('date'), '2026-03-01')).toMatch(/1/);
    expect(formatFieldValue(field('date'), '2026-03-01')).not.toMatch(/28|29/);
  });
});
