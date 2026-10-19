import {
  assetStatusLabels,
  type AssetField,
  type AssetStatus,
  type FieldValue,
} from '@open-itsm/shared';
import type { Tone } from '@/components/ui/status-shape';

/** Status tones from the design system: each status keeps one word, shape and colour. */
export const assetStatusTones: Record<AssetStatus, Tone> = {
  deployed: 'info',
  preparing: 'progress',
  in_repair: 'warning',
  in_stock: 'success',
  retired: 'neutral',
};

export { assetStatusLabels };

const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const longDateFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

/** `Oct 17` within this year, `Oct 17, 2025` otherwise. */
export function formatDate(iso: string): string {
  const date = new Date(iso);
  return date.getFullYear() === new Date().getFullYear()
    ? dateFormat.format(date)
    : longDateFormat.format(date);
}

/** A stored field value as people read it; dates are stored as YYYY-MM-DD. */
export function formatFieldValue(field: AssetField, value: FieldValue | undefined): string {
  if (value === undefined || value === '') return '—';
  if (field.kind === 'boolean') return value ? 'Yes' : 'No';
  if (field.kind === 'date' && typeof value === 'string') {
    return longDateFormat.format(new Date(`${value}T00:00:00`));
  }
  if (field.kind === 'number' && typeof value === 'number') return value.toLocaleString();
  return String(value);
}
