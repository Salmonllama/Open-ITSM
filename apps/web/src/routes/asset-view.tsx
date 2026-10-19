import { assetSchema, type UpdateAssetRequest } from '@open-itsm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createRoute, useNavigate } from '@tanstack/react-router';
import { Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { AssetForm } from '@/components/asset-form';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button, buttonClasses } from '@/components/ui/button';
import { Card, ErrorMessage } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { apiRequest } from '@/lib/api';
import { assetStatusLabels, assetStatusTones, formatDate, formatFieldValue } from '@/lib/assets';
import { assetQuery, assetTypeQuery, assetTypesQuery } from '@/lib/queries';
import { authedRoute } from './authed';

export const assetViewRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/assets/$assetId',
  component: AssetPage,
});

export const assetEditRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/assets/$assetId/edit',
  component: EditAssetPage,
});

function Breadcrumb({ typeName, number }: { typeName: string; number: string }) {
  return (
    <nav aria-label="Breadcrumb" className="type-caption text-ink-muted">
      <Link to="/assets" activeOptions={{ exact: true }}>
        Assets
      </Link>{' '}
      <span aria-hidden="true">/</span> {typeName} <span aria-hidden="true">/</span>{' '}
      <span className="type-id">{number}</span>
    </nav>
  );
}

function AssetPage() {
  const { assetId } = assetViewRoute.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const asset = useQuery(assetQuery(assetId));
  const type = useQuery({ ...assetTypeQuery(asset.data?.type.id ?? ''), enabled: !!asset.data });
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const remove = useMutation({
    mutationFn: () => apiRequest('DELETE', `/api/assets/${assetId}`),
    onSuccess: async () => {
      setConfirmingDelete(false);
      // Leave the page first so nothing refetches the asset that is gone.
      await navigate({ to: '/assets' });
      queryClient.removeQueries({ queryKey: ['assets', assetId] });
      await queryClient.invalidateQueries({ queryKey: ['assets'] });
      await queryClient.invalidateQueries({ queryKey: assetTypesQuery.queryKey });
    },
  });

  if (asset.isPending) return <p className="m-0 text-ink-muted">Loading asset…</p>;
  if (asset.error) return <ErrorMessage error={asset.error} />;
  const a = asset.data;
  const updated = `updated ${formatDate(a.updatedAt)}${a.updatedBy ? ` by ${a.updatedBy.name}` : ''}`;

  return (
    <>
      <Breadcrumb typeName={a.type.name} number={a.number} />
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <p className="m-0 type-id text-ink-muted">{a.number}</p>
          <h1 className="m-0 type-title">{a.name}</h1>
          <div className="flex flex-wrap items-center gap-3">
            <StatusBadge tone={assetStatusTones[a.status]}>
              {assetStatusLabels[a.status]}
            </StatusBadge>
            <span className="type-caption text-ink-muted">
              {a.type.name} · {updated}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to="/assets/$assetId/edit" params={{ assetId }} className={buttonClasses('ghost')}>
            <Pencil aria-hidden="true" strokeWidth={1.75} />
            Edit
          </Link>
          <Button variant="danger" onClick={() => setConfirmingDelete(true)}>
            <Trash2 aria-hidden="true" strokeWidth={1.75} />
            Delete
          </Button>
        </div>
      </header>

      <Card className="flex flex-col gap-4 p-6">
        <h2 className="m-0 type-heading">Details</h2>
        <ErrorMessage error={type.error} />
        <dl className="m-0 grid gap-x-8 gap-y-4 sm:grid-cols-2">
          <Detail label="Asset number" value={a.number} mono />
          <Detail label="Type" value={a.type.name} />
          <Detail label="Added" value={formatDate(a.createdAt)} />
          {type.data?.fields.map((field) => (
            <Detail
              key={field.key}
              label={field.label}
              value={formatFieldValue(field, a.fields[field.key])}
            />
          ))}
        </dl>
        {type.data && type.data.fields.length === 0 && (
          <p className="m-0 type-caption text-ink-muted">
            {a.type.name} has no custom fields.{' '}
            <Link to="/asset-types/$typeId" params={{ typeId: a.type.id }}>
              Add fields to the type
            </Link>{' '}
            to record more about each asset.
          </p>
        )}
      </Card>

      <ConfirmDialog
        open={confirmingDelete}
        title={`Delete ${a.number}?`}
        confirmLabel="Delete asset"
        danger
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
        onCancel={() => {
          setConfirmingDelete(false);
          remove.reset();
        }}
      >
        <p className="m-0">
          {a.name} and its field values are removed for good. The audit log keeps a record that you
          deleted it. Use this for assets added by mistake.
        </p>
        {confirmingDelete && <ErrorMessage error={remove.error} />}
      </ConfirmDialog>
    </>
  );
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="type-caption text-ink-muted">{label}</dt>
      <dd className={mono ? 'm-0 type-id' : 'm-0'}>{value}</dd>
    </div>
  );
}

function EditAssetPage() {
  const { assetId } = assetEditRoute.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const asset = useQuery(assetQuery(assetId));
  const type = useQuery({ ...assetTypeQuery(asset.data?.type.id ?? ''), enabled: !!asset.data });

  const update = useMutation({
    mutationFn: (body: UpdateAssetRequest) =>
      apiRequest('PATCH', `/api/assets/${assetId}`, { body, schema: assetSchema }),
    onSuccess: async (saved) => {
      queryClient.setQueryData(assetQuery(assetId).queryKey, saved);
      await queryClient.invalidateQueries({ queryKey: ['assets', 'list'] });
      await navigate({ to: '/assets/$assetId', params: { assetId } });
    },
  });

  if (asset.error || type.error) return <ErrorMessage error={asset.error ?? type.error} />;
  if (!asset.data || !type.data) return <p className="m-0 text-ink-muted">Loading asset…</p>;
  const a = asset.data;

  return (
    <>
      <Breadcrumb typeName={a.type.name} number={a.number} />
      <h1 className="m-0 type-display">Edit {a.number}</h1>
      <AssetForm
        type={type.data}
        asset={a}
        heading={a.name}
        submitLabel="Save changes"
        pending={update.isPending}
        error={update.error}
        onSubmit={(values) => update.mutate(values)}
        onCancel={() => void navigate({ to: '/assets/$assetId', params: { assetId } })}
      />
    </>
  );
}
