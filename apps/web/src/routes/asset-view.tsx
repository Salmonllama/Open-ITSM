import { assetSchema, type UpdateAssetRequest } from '@open-itsm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createRoute, useNavigate } from '@tanstack/react-router';
import { Pencil, QrCode, Trash2, Undo2, UserCheck, Wrench } from 'lucide-react';
import { useState } from 'react';
import { AssetForm } from '@/components/asset-form';
import { AssetTag } from '@/components/asset-tag';
import {
  ActivityCard,
  AssetActionDialogs,
  AssignmentHistoryCard,
  CurrentAssignmentCard,
  RepairsCard,
  canDelete,
  type AssetDialog,
} from '@/components/asset-history';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button, buttonClasses } from '@/components/ui/button';
import { Card, ErrorMessage } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { apiRequest } from '@/lib/api';
import { assetStatusLabels, assetStatusTones, formatDate, formatFieldValue } from '@/lib/assets';
import { assetHistoryQuery, assetQuery, assetTypeQuery, assetTypesQuery } from '@/lib/queries';
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
  const history = useQuery(assetHistoryQuery(assetId));
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [dialog, setDialog] = useState<AssetDialog>(null);

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
  const openRepair = history.data?.repairs.find((r) => r.closedAt === null);
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
          {canDelete(history.data) && (
            <Button variant="danger" onClick={() => setConfirmingDelete(true)}>
              <Trash2 aria-hidden="true" strokeWidth={1.75} />
              Delete
            </Button>
          )}
          {a.status === 'in_repair' ? (
            <Button
              variant="primary"
              disabled={!openRepair}
              onClick={() => setDialog('close-repair')}
            >
              <Wrench aria-hidden="true" strokeWidth={1.75} />
              Close repair
            </Button>
          ) : a.status === 'retired' ? (
            <Button variant="primary" onClick={() => setDialog('status')}>
              Change status
            </Button>
          ) : (
            <>
              <Button onClick={() => setDialog('repair')}>
                <Wrench aria-hidden="true" strokeWidth={1.75} />
                Log repair
              </Button>
              {a.status === 'deployed' ? (
                <>
                  <Button onClick={() => setDialog('assign')}>
                    <UserCheck aria-hidden="true" strokeWidth={1.75} />
                    Reassign
                  </Button>
                  <Button variant="primary" onClick={() => setDialog('return')}>
                    <Undo2 aria-hidden="true" strokeWidth={1.75} />
                    Return
                  </Button>
                </>
              ) : (
                <>
                  <Button onClick={() => setDialog('status')}>Change status</Button>
                  <Button variant="primary" onClick={() => setDialog('assign')}>
                    <UserCheck aria-hidden="true" strokeWidth={1.75} />
                    Assign
                  </Button>
                </>
              )}
            </>
          )}
        </div>
      </header>
      <ErrorMessage error={history.error} />

      <div className="flex flex-wrap items-start gap-6">
        <div className="flex min-w-0 flex-[999_1_520px] flex-col gap-6">
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
          <AssignmentHistoryCard history={history.data} />
          <RepairsCard asset={a} history={history.data} />
        </div>
        <aside className="flex min-w-0 flex-[1_1_300px] flex-col gap-6">
          <CurrentAssignmentCard history={history.data} />
          <Card className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="m-0 type-heading">Asset tag</h2>
              <Link
                to="/assets/labels"
                search={{ ids: a.id }}
                className={buttonClasses('secondary', 'sm')}
              >
                <QrCode aria-hidden="true" strokeWidth={1.75} />
                Print tag
              </Link>
            </div>
            <div className="[zoom:1.25]">
              <AssetTag number={a.number} typeName={a.type.name} name={a.name} />
            </div>
          </Card>
          <ActivityCard history={history.data} />
        </aside>
      </div>

      <AssetActionDialogs
        asset={a}
        openRepair={openRepair}
        dialog={dialog}
        onClose={() => setDialog(null)}
      />

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
