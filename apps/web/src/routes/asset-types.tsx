import {
  FIELD_KINDS,
  assetFieldSchema,
  assetTypeSchema,
  fieldKindLabels,
  formatAssetNumber,
  type AssetField,
  type AssetType,
  type CreateAssetTypeRequest,
  type CreateFieldRequest,
  type FieldKind,
  type UpdateAssetTypeRequest,
  type UpdateFieldRequest,
} from '@open-itsm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createRoute, useNavigate } from '@tanstack/react-router';
import { Plus, Trash2 } from 'lucide-react';
import { Fragment, useId, useState, type FormEvent } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { FormField } from '@/components/form-field';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, ErrorMessage } from '@/components/ui/card';
import { Label, Select } from '@/components/ui/input';
import { Table, Td, Th } from '@/components/ui/table';
import { apiRequest } from '@/lib/api';
import { assetTypeQuery, assetTypesQuery } from '@/lib/queries';
import { authedRoute } from './authed';

export const assetTypesRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/asset-types',
  component: AssetTypesPage,
});

export const assetTypeRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/asset-types/$typeId',
  component: AssetTypePage,
});

/** Options typed one per line or separated by commas. */
function parseOptions(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((o) => o.trim())
    .filter((o) => o !== '');
}

function AssetTypesPage() {
  const types = useQuery(assetTypesQuery);
  const [adding, setAdding] = useState(false);

  return (
    <>
      <PageHeader
        title="Asset types"
        caption="A type, such as Laptop or Phone, sets the number prefix and the fields its assets carry."
        actions={
          !adding && (
            <Button variant="primary" onClick={() => setAdding(true)}>
              <Plus aria-hidden="true" strokeWidth={1.75} />
              New asset type
            </Button>
          )
        }
      />
      {adding && <CreateTypeForm onDone={() => setAdding(false)} />}
      {types.isPending && <p className="m-0 text-ink-muted">Loading asset types…</p>}
      <ErrorMessage error={types.error} />
      {types.data && (
        <Table>
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>Prefix</Th>
              <Th>Next number</Th>
              <Th>Fields</Th>
              <Th>Assets</Th>
            </tr>
          </thead>
          <tbody>
            {types.data.map((type) => (
              <tr key={type.id}>
                <Td>
                  <Link to="/asset-types/$typeId" params={{ typeId: type.id }}>
                    {type.name}
                  </Link>
                </Td>
                <Td className="type-id">{type.prefix}</Td>
                <Td className="type-id">{formatAssetNumber(type.prefix, type.nextNumber)}</Td>
                <Td>{type.fields.length}</Td>
                <Td>
                  <Link to="/assets" search={{ typeId: type.id }}>
                    {type.assetCount}
                  </Link>
                </Td>
              </tr>
            ))}
            {types.data.length === 0 && (
              <tr>
                <Td colSpan={5} className="text-ink-muted">
                  No asset types yet. Add one with New asset type, then add assets of that type.
                </Td>
              </tr>
            )}
          </tbody>
        </Table>
      )}
    </>
  );
}

function CreateTypeForm({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: (body: CreateAssetTypeRequest) =>
      apiRequest('POST', '/api/asset-types', { body, schema: assetTypeSchema }),
    onSuccess: async (type) => {
      await queryClient.invalidateQueries({ queryKey: assetTypesQuery.queryKey });
      onDone();
      await navigate({ to: '/asset-types/$typeId', params: { typeId: type.id } });
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    create.mutate({ name: String(form.get('name')), prefix: String(form.get('prefix')) });
  }

  return (
    <Card>
      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        <h2 className="m-0 type-heading">New asset type</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Name" name="name" required autoComplete="off" hint="Like Laptop." />
          <FormField
            label="Number prefix"
            name="prefix"
            required
            mono
            autoComplete="off"
            maxLength={10}
            pattern="[A-Za-z0-9]{1,10}"
            hint="1 to 10 letters or digits. LAP makes asset numbers like LAP-000001."
          />
        </div>
        <ErrorMessage error={create.error} />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" disabled={create.isPending}>
            Create asset type
          </Button>
          <Button onClick={onDone}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}

function AssetTypePage() {
  const { typeId } = assetTypeRoute.useParams();
  const type = useQuery(assetTypeQuery(typeId));

  if (type.isPending) return <p className="m-0 text-ink-muted">Loading asset type…</p>;
  if (type.error) return <ErrorMessage error={type.error} />;

  return (
    <>
      <nav aria-label="Breadcrumb" className="type-caption text-ink-muted">
        <Link to="/asset-types" activeOptions={{ exact: true }}>
          Asset types
        </Link>{' '}
        <span aria-hidden="true">/</span> {type.data.name}
      </nav>
      <PageHeader
        title={type.data.name}
        caption={
          <>
            <Link to="/assets" search={{ typeId }}>
              {type.data.assetCount} {type.data.assetCount === 1 ? 'asset' : 'assets'}
            </Link>{' '}
            · next number{' '}
            <span className="type-id">
              {formatAssetNumber(type.data.prefix, type.data.nextNumber)}
            </span>
          </>
        }
      />
      <TypeSettings
        key={`${type.data.name}|${type.data.prefix}|${type.data.nextNumber}`}
        type={type.data}
      />
      <Fields type={type.data} />
      <DeleteType type={type.data} />
    </>
  );
}

/** Invalidates the type (this page) and the list, which shows names and counts. */
function useRefreshTypes(typeId: string) {
  const queryClient = useQueryClient();
  return async () => {
    await queryClient.invalidateQueries({ queryKey: assetTypeQuery(typeId).queryKey });
    await queryClient.invalidateQueries({ queryKey: assetTypesQuery.queryKey, exact: true });
  };
}

function TypeSettings({ type }: { type: AssetType }) {
  const refresh = useRefreshTypes(type.id);
  const [saved, setSaved] = useState(false);
  const update = useMutation({
    mutationFn: (body: UpdateAssetTypeRequest) =>
      apiRequest('PATCH', `/api/asset-types/${type.id}`, { body, schema: assetTypeSchema }),
    onSuccess: async () => {
      setSaved(true);
      await refresh();
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaved(false);
    const form = new FormData(event.currentTarget);
    update.mutate({
      name: String(form.get('name')),
      prefix: String(form.get('prefix')),
      nextNumber: Number(form.get('nextNumber')),
    });
  }

  return (
    <Card>
      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        <h2 className="m-0 type-heading">Settings</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <FormField
            label="Name"
            name="name"
            required
            autoComplete="off"
            defaultValue={type.name}
          />
          <FormField
            label="Number prefix"
            name="prefix"
            required
            mono
            autoComplete="off"
            maxLength={10}
            pattern="[A-Za-z0-9]{1,10}"
            defaultValue={type.prefix}
            hint="Applies to new numbers. Existing assets keep theirs."
          />
          <FormField
            label="Next number"
            name="nextNumber"
            type="number"
            required
            min={1}
            max={999_999_999}
            mono
            defaultValue={type.nextNumber}
            hint="Numbers already in use are skipped."
          />
        </div>
        <ErrorMessage error={update.error} />
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" disabled={update.isPending}>
            Save settings
          </Button>
          {saved && (
            <span role="status" className="type-caption text-ink-muted">
              Settings saved.
            </span>
          )}
        </div>
      </form>
    </Card>
  );
}

function Fields({ type }: { type: AssetType }) {
  const [adding, setAdding] = useState(false);
  return (
    <section aria-labelledby="fields-heading" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 id="fields-heading" className="m-0 type-heading">
            Fields
          </h2>
          <p className="m-0 type-caption text-ink-muted">
            What you record about each {type.name}, such as serial number or purchase date.
          </p>
        </div>
        {!adding && (
          <Button onClick={() => setAdding(true)}>
            <Plus aria-hidden="true" strokeWidth={1.75} />
            Add field
          </Button>
        )}
      </div>
      {adding && <AddFieldForm type={type} onDone={() => setAdding(false)} />}
      <Table>
        <thead>
          <tr>
            <Th>Label</Th>
            <Th>Kind</Th>
            <Th>Required</Th>
            <Th>
              <span className="sr-only">Actions</span>
            </Th>
          </tr>
        </thead>
        <tbody>
          {type.fields.map((field) => (
            <FieldRow key={field.id} type={type} field={field} />
          ))}
          {type.fields.length === 0 && (
            <tr>
              <Td colSpan={4} className="text-ink-muted">
                No fields yet. Assets of this type have a number, name and status only.
              </Td>
            </tr>
          )}
        </tbody>
      </Table>
    </section>
  );
}

function AddFieldForm({ type, onDone }: { type: AssetType; onDone: () => void }) {
  const refresh = useRefreshTypes(type.id);
  const kindId = useId();
  const [kind, setKind] = useState<FieldKind>('text');
  const create = useMutation({
    mutationFn: (body: CreateFieldRequest) =>
      apiRequest('POST', `/api/asset-types/${type.id}/fields`, { body, schema: assetFieldSchema }),
    onSuccess: async () => {
      await refresh();
      onDone();
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    create.mutate({
      label: String(form.get('label')),
      kind,
      options: kind === 'select' ? parseOptions(String(form.get('options') ?? '')) : [],
      required: form.get('required') === 'on',
    });
  }

  return (
    <Card>
      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        <h3 className="m-0 type-heading">Add field</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            label="Label"
            name="label"
            required
            autoComplete="off"
            hint="Like Serial number."
          />
          <div className="flex flex-col gap-2">
            <Label htmlFor={kindId}>Kind</Label>
            <Select id={kindId} value={kind} onChange={(e) => setKind(e.target.value as FieldKind)}>
              {FIELD_KINDS.map((k) => (
                <option key={k} value={k}>
                  {fieldKindLabels[k]}
                </option>
              ))}
            </Select>
            <p className="m-0 type-caption text-ink-muted">The kind cannot change later.</p>
          </div>
          {kind === 'select' && <OptionsField />}
        </div>
        <RequiredCheckbox />
        <ErrorMessage error={create.error} />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" disabled={create.isPending}>
            Add field
          </Button>
          <Button onClick={onDone}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}

function OptionsField({ defaultValue }: { defaultValue?: string[] }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2 sm:col-span-2">
      <Label htmlFor={id}>Choices</Label>
      <textarea
        id={id}
        name="options"
        required
        rows={4}
        defaultValue={defaultValue?.join('\n')}
        aria-describedby={`${id}-hint`}
        className="rounded-md border border-line-strong bg-surface-raised px-3 py-2 type-body text-ink focus-visible:shadow-focus focus-visible:outline-2 focus-visible:outline-transparent"
      />
      <p id={`${id}-hint`} className="m-0 type-caption text-ink-muted">
        One per line, or separated by commas.
      </p>
    </div>
  );
}

function RequiredCheckbox({ defaultChecked }: { defaultChecked?: boolean }) {
  const id = useId();
  return (
    <div className="flex items-start gap-2">
      <input
        id={id}
        type="checkbox"
        name="required"
        defaultChecked={defaultChecked}
        className="mt-1 size-4 accent-pine"
        aria-describedby={`${id}-hint`}
      />
      <div className="flex flex-col gap-1">
        <Label htmlFor={id}>Required</Label>
        <p id={`${id}-hint`} className="m-0 type-caption text-ink-muted">
          New and edited assets must have a value. Existing assets are not checked until edited.
        </p>
      </div>
    </div>
  );
}

function FieldRow({ type, field }: { type: AssetType; field: AssetField }) {
  const refresh = useRefreshTypes(type.id);
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const update = useMutation({
    mutationFn: (body: UpdateFieldRequest) =>
      apiRequest('PATCH', `/api/asset-types/${type.id}/fields/${field.id}`, {
        body,
        schema: assetFieldSchema,
      }),
    onSuccess: async () => {
      await refresh();
      setEditing(false);
    },
  });
  const remove = useMutation({
    mutationFn: () => apiRequest('DELETE', `/api/asset-types/${type.id}/fields/${field.id}`),
    onSuccess: async () => {
      setConfirmingDelete(false);
      await refresh();
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    update.mutate({
      label: String(form.get('label')),
      required: form.get('required') === 'on',
      ...(field.kind === 'select' && { options: parseOptions(String(form.get('options') ?? '')) }),
    });
  }

  return (
    <Fragment>
      <tr>
        <Td>
          {field.label}
          {field.kind === 'select' && (
            <p className="m-0 type-caption text-ink-muted">{field.options.join(', ')}</p>
          )}
        </Td>
        <Td>{fieldKindLabels[field.kind]}</Td>
        <Td>{field.required ? 'Yes' : 'No'}</Td>
        <Td>
          <div className="flex justify-end gap-2">
            <Button size="sm" aria-expanded={editing} onClick={() => setEditing((v) => !v)}>
              Edit
            </Button>
            <Button size="sm" onClick={() => setConfirmingDelete(true)}>
              <Trash2 aria-hidden="true" strokeWidth={1.75} />
              Delete
            </Button>
          </div>
          <ConfirmDialog
            open={confirmingDelete}
            title={`Delete the ${field.label} field?`}
            confirmLabel="Delete field"
            danger
            pending={remove.isPending}
            onConfirm={() => remove.mutate()}
            onCancel={() => {
              setConfirmingDelete(false);
              remove.reset();
            }}
          >
            <p className="m-0">
              Every {type.name} loses its {field.label} value. This cannot be undone.
            </p>
            {confirmingDelete && <ErrorMessage error={remove.error} />}
          </ConfirmDialog>
        </Td>
      </tr>
      {editing && (
        <tr>
          <td colSpan={4} className="bg-surface px-4 py-4">
            <form className="flex flex-col gap-4" onSubmit={onSubmit}>
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField
                  label="Label"
                  name="label"
                  required
                  autoComplete="off"
                  defaultValue={field.label}
                  hint="Renaming keeps every stored value."
                />
                {field.kind === 'select' && <OptionsField defaultValue={field.options} />}
              </div>
              <RequiredCheckbox defaultChecked={field.required} />
              <ErrorMessage error={update.error} />
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={update.isPending}>
                  Save field
                </Button>
                <Button onClick={() => setEditing(false)}>Cancel</Button>
              </div>
            </form>
          </td>
        </tr>
      )}
    </Fragment>
  );
}

function DeleteType({ type }: { type: AssetType }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({
    mutationFn: () => apiRequest('DELETE', `/api/asset-types/${type.id}`),
    onSuccess: async () => {
      setConfirming(false);
      await navigate({ to: '/asset-types' });
      queryClient.removeQueries({ queryKey: assetTypeQuery(type.id).queryKey });
      await queryClient.invalidateQueries({ queryKey: assetTypesQuery.queryKey, exact: true });
    },
  });

  return (
    <section
      aria-labelledby="delete-type"
      className="flex flex-col gap-2 border-t border-line pt-6"
    >
      <h2 id="delete-type" className="m-0 type-heading">
        Delete this type
      </h2>
      {type.assetCount > 0 ? (
        <p className="m-0 text-ink-muted">
          {type.name} has {type.assetCount} {type.assetCount === 1 ? 'asset' : 'assets'}. A type can
          be deleted only when no assets use it.
        </p>
      ) : (
        <>
          <p className="m-0 text-ink-muted">No assets use {type.name}, so it can be deleted.</p>
          <div>
            <Button variant="danger" onClick={() => setConfirming(true)}>
              <Trash2 aria-hidden="true" strokeWidth={1.75} />
              Delete {type.name}
            </Button>
          </div>
        </>
      )}
      <ConfirmDialog
        open={confirming}
        title={`Delete ${type.name}?`}
        confirmLabel="Delete asset type"
        danger
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
        onCancel={() => {
          setConfirming(false);
          remove.reset();
        }}
      >
        <p className="m-0">
          {type.name} and its field definitions are removed. This cannot be undone.
        </p>
        {confirming && <ErrorMessage error={remove.error} />}
      </ConfirmDialog>
    </section>
  );
}
