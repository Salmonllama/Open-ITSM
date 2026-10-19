import {
  TEXT_FIELD_MAX,
  type FieldKind,
  type FieldValue,
  type FieldValues,
} from '@open-itsm/shared';

export type FieldDef = {
  key: string;
  label: string;
  kind: FieldKind;
  options: string[];
  required: boolean;
};

export type FieldProblem = { key: string; label: string; message: string };

/** `Serial number` becomes `serial_number`; a clash with an existing key gets `_2`, `_3`... */
export function fieldKey(label: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  let base = label
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50);
  if (!/^[a-z]/.test(base)) base = `field_${base}`.replace(/_+$/, '');
  let key = base;
  for (let n = 2; used.has(key); n += 1) key = `${base}_${n}`;
  return key;
}

function isDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

/** Checks one value against its field; returns the value to store or a problem message. */
function checkValue(
  field: FieldDef,
  value: FieldValue,
): { value: FieldValue } | { message: string } {
  switch (field.kind) {
    case 'text':
      if (typeof value !== 'string') return { message: 'Enter text' };
      if (value.length > TEXT_FIELD_MAX)
        return { message: `Use at most ${TEXT_FIELD_MAX} characters` };
      return { value };
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value))
        return { message: 'Enter a number' };
      return { value };
    case 'date':
      if (typeof value !== 'string' || !isDate(value)) {
        return { message: 'Enter a date as YYYY-MM-DD, like 2026-10-19' };
      }
      return { value };
    case 'select':
      if (typeof value !== 'string' || !field.options.includes(value)) {
        return { message: `Choose one of: ${field.options.join(', ')}` };
      }
      return { value };
    case 'boolean':
      if (typeof value !== 'boolean') return { message: 'Choose yes or no' };
      return { value };
  }
}

/**
 * Validates a full set of custom field values against a type's fields. Blank text counts as
 * not set; keys that are not fields of the type are refused.
 */
export function validateFieldValues(
  fields: FieldDef[],
  input: FieldValues,
): { values: FieldValues; problems: FieldProblem[] } {
  const values: FieldValues = {};
  const problems: FieldProblem[] = [];
  const byKey = new Map(fields.map((f) => [f.key, f]));

  for (const key of Object.keys(input)) {
    if (!byKey.has(key)) {
      problems.push({ key, label: key, message: 'is not a field of this asset type' });
    }
  }
  for (const field of fields) {
    let value = input[field.key];
    if (typeof value === 'string') value = value.trim();
    if (value === undefined || value === '') {
      if (field.required)
        problems.push({ key: field.key, label: field.label, message: 'is required' });
      continue;
    }
    const checked = checkValue(field, value);
    if ('message' in checked) {
      problems.push({ key: field.key, label: field.label, message: checked.message });
    } else {
      values[field.key] = checked.value;
    }
  }
  return { values, problems };
}

const YES = new Set(['yes', 'y', 'true', '1']);
const NO = new Set(['no', 'n', 'false', '0']);

/** Turns a CSV cell into the value its field expects, leaving checks to validateFieldValues. */
export function fromCsvCell(field: FieldDef, cell: string): FieldValue | undefined {
  const text = cell.trim();
  if (text === '') return undefined;
  switch (field.kind) {
    case 'number': {
      const n = Number(text.replaceAll(',', ''));
      return Number.isFinite(n) ? n : text;
    }
    case 'boolean': {
      const lower = text.toLowerCase();
      return YES.has(lower) ? true : NO.has(lower) ? false : text;
    }
    case 'select':
      // Match a choice regardless of case, so "dell" fills "Dell".
      return field.options.find((o) => o.toLowerCase() === text.toLowerCase()) ?? text;
    default:
      return text;
  }
}
