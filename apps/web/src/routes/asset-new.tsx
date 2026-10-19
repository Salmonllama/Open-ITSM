import { assetSchema, type CreateAssetRequest } from '@open-itsm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createRoute, useNavigate } from '@tanstack/react-router';
import { useId } from 'react';
import { z } from 'zod';
import { AssetForm } from '@/components/asset-form';
import { PageHeader } from '@/components/page-header';
import { ErrorMessage } from '@/components/ui/card';
import { Label, Select } from '@/components/ui/input';
import { apiRequest } from '@/lib/api';
import { assetTypesQuery } from '@/lib/queries';
import { authedRoute } from './authed';

export const assetNewRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/assets/new',
  validateSearch: z.object({ typeId: z.uuid().optional().catch(undefined) }),
  component: NewAssetPage,
});

function NewAssetPage() {
  const { typeId } = assetNewRoute.useSearch();
  const navigate = useNavigate({ from: '/assets/new' });
  const queryClient = useQueryClient();
  const typeSelectId = useId();
  const types = useQuery(assetTypesQuery);
  const type = types.data?.find((t) => t.id === typeId) ?? types.data?.[0];

  const create = useMutation({
    mutationFn: (body: CreateAssetRequest) =>
      apiRequest('POST', '/api/assets', { body, schema: assetSchema }),
    onSuccess: async (asset) => {
      await queryClient.invalidateQueries({ queryKey: ['assets'] });
      await queryClient.invalidateQueries({ queryKey: assetTypesQuery.queryKey });
      await navigate({ to: '/assets/$assetId', params: { assetId: asset.id } });
    },
  });

  return (
    <>
      <nav aria-label="Breadcrumb" className="type-caption text-ink-muted">
        <Link to="/assets" activeOptions={{ exact: true }}>
          Assets
        </Link>{' '}
        <span aria-hidden="true">/</span> New asset
      </nav>
      <PageHeader title="New asset" />
      <ErrorMessage error={types.error} />
      {types.data && !type && (
        <p className="m-0">
          Add an asset type first; it sets the number prefix and fields.{' '}
          <Link to="/asset-types">Go to asset types</Link>
        </p>
      )}
      {type && (
        <AssetForm
          key={type.id}
          type={type}
          heading={`New ${type.name}`}
          typePicker={
            <div className="flex max-w-sm flex-col gap-2">
              <Label htmlFor={typeSelectId}>Type</Label>
              <Select
                id={typeSelectId}
                value={type.id}
                onChange={(e) =>
                  void navigate({ search: { typeId: e.target.value }, replace: true })
                }
              >
                {types.data?.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </div>
          }
          submitLabel="Create asset"
          pending={create.isPending}
          error={create.error}
          onSubmit={(values) => create.mutate({ typeId: type.id, ...values })}
          onCancel={() => void navigate({ to: '/assets' })}
        />
      )}
    </>
  );
}
