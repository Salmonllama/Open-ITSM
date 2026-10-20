import {
  SETTABLE_ASSET_STATUSES,
  formatAssetNumber,
  isSettableStatus,
  type Asset,
  type AssetField,
  type AssetType,
  type FieldValues,
  type SettableAssetStatus,
} from '@open-itsm/shared';
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { assetStatusLabels } from '@/lib/assets';
import { FormField } from './form-field';
import { Button } from './ui/button';
import { Card, ErrorMessage } from './ui/card';
import { Input, Label, Select } from './ui/input';

export type AssetFormValues = {
  number: string | undefined;
  name: string;
  /** Left out while the asset is deployed or in repair; those come from its history. */
  status?: SettableAssetStatus;
  fields: FieldValues;
};

/** Field values as form text; booleans become 'yes'/'no' and missing values ''. */
function toText(fields: AssetField[], values: FieldValues): Record<string, string> {
  return Object.fromEntries(
    fields.map((f) => {
      const v = values[f.key];
      if (v === undefined) return [f.key, ''];
      if (typeof v === 'boolean') return [f.key, v ? 'yes' : 'no'];
      return [f.key, String(v)];
    }),
  );
}

/** Form text back to typed values; a number the browser accepted but cannot parse stays text. */
function fromText(fields: AssetField[], text: Record<string, string>): FieldValues {
  const values: FieldValues = {};
  for (const field of fields) {
    const raw = (text[field.key] ?? '').trim();
    if (raw === '') continue;
    if (field.kind === 'boolean') values[field.key] = raw === 'yes';
    else if (field.kind === 'number')
      values[field.key] = Number.isFinite(Number(raw)) ? Number(raw) : raw;
    else values[field.key] = raw;
  }
  return values;
}

/**
 * Number, name, status and the type's custom fields. Used to create an asset (the number may be
 * left blank to take the next one) and to edit one.
 */
export function AssetForm({
  type,
  asset,
  heading,
  typePicker,
  submitLabel,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  type: AssetType;
  asset?: Asset;
  heading: string;
  typePicker?: ReactNode;
  submitLabel: string;
  pending: boolean;
  error: unknown;
  onSubmit: (values: AssetFormValues) => void;
  onCancel: () => void;
}) {
  const statusId = useId();
  const statusEditable = asset === undefined || isSettableStatus(asset.status);
  const [fieldText, setFieldText] = useState(() => toText(type.fields, asset?.fields ?? {}));

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const number = String(form.get('number') ?? '').trim();
    onSubmit({
      number: number === '' ? undefined : number,
      name: String(form.get('name')),
      ...(statusEditable ? { status: String(form.get('status')) as SettableAssetStatus } : {}),
      fields: fromText(type.fields, fieldText),
    });
  }

  return (
    <Card>
      <form className="flex flex-col gap-6" onSubmit={submit}>
        <h2 className="m-0 type-heading">{heading}</h2>
        {typePicker}
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            label="Asset number"
            name="number"
            mono
            autoComplete="off"
            required={asset !== undefined}
            defaultValue={asset?.number}
            placeholder={asset ? undefined : formatAssetNumber(type.prefix, type.nextNumber)}
            hint={
              asset
                ? 'Unique across all assets. Change it only if the label on the device is different.'
                : `Leave blank to use the next ${type.name} number. Unique across all assets.`
            }
          />
          <FormField
            label="Name"
            name="name"
            required
            autoComplete="off"
            defaultValue={asset?.name}
            hint="What people call it, like Dell Latitude 5440."
          />
          {statusEditable ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor={statusId}>Status</Label>
              <Select id={statusId} name="status" defaultValue={asset?.status ?? 'in_stock'}>
                {SETTABLE_ASSET_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {assetStatusLabels[s]}
                  </option>
                ))}
              </Select>
              <p className="m-0 type-caption text-ink-muted">
                Assigning an asset sets it to Deployed; logging a repair sets it to In repair.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <span className="type-label">Status</span>
              <p className="m-0 type-caption text-ink-muted">
                {asset.status === 'deployed'
                  ? 'Deployed while it is assigned. Return it from the asset page to change the status.'
                  : 'In repair until the repair is closed from the asset page.'}
              </p>
            </div>
          )}
        </div>
        {type.fields.length > 0 && (
          <fieldset className="m-0 flex flex-col gap-4 border-0 p-0">
            <legend className="mb-4 p-0 type-heading">Details</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              {type.fields.map((field) => (
                <CustomFieldInput
                  key={field.key}
                  field={field}
                  value={fieldText[field.key] ?? ''}
                  onChange={(v) => setFieldText((prev) => ({ ...prev, [field.key]: v }))}
                />
              ))}
            </div>
          </fieldset>
        )}
        <ErrorMessage error={error} />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" disabled={pending}>
            {submitLabel}
          </Button>
          <Button onClick={onCancel}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}

function CustomFieldInput({
  field,
  value,
  onChange,
}: {
  field: AssetField;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const label = field.required ? field.label : `${field.label} (optional)`;
  if (field.kind === 'select' || field.kind === 'boolean') {
    const options =
      field.kind === 'boolean'
        ? [
            { value: 'yes', label: 'Yes' },
            { value: 'no', label: 'No' },
          ]
        : field.options.map((o) => ({ value: o, label: o }));
    return (
      <div className="flex flex-col gap-2">
        <Label htmlFor={id}>{label}</Label>
        <Select
          id={id}
          value={value}
          required={field.required}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">Not set</option>
          {/* Keep a stored value visible even if it is no longer a choice. */}
          {value !== '' && !options.some((o) => o.value === value) && (
            <option value={value}>{value}</option>
          )}
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={field.kind === 'number' ? 'number' : field.kind === 'date' ? 'date' : 'text'}
        step={field.kind === 'number' ? 'any' : undefined}
        required={field.required}
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
