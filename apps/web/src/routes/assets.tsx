import { ASSET_STATUSES, assetStatusSchema, type AssetStatus } from '@open-itsm/shared';
import { useQuery } from '@tanstack/react-query';
import { Link, createRoute, useNavigate } from '@tanstack/react-router';
import { Plus, QrCode, Upload } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { z } from 'zod';
import { PageHeader } from '@/components/page-header';
import { Button, buttonClasses } from '@/components/ui/button';
import { ErrorMessage } from '@/components/ui/card';
import { Input, Label, Select } from '@/components/ui/input';
import { StatusBadge } from '@/components/ui/status-badge';
import { Table, Td, Th } from '@/components/ui/table';
import { assetStatusLabels, assetStatusTones, formatDate } from '@/lib/assets';
import { assetsQuery, assetTypesQuery } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { authedRoute } from './authed';

const PAGE_SIZE = 25;

const searchSchema = z.object({
  q: z.string().optional().catch(undefined),
  status: assetStatusSchema.optional().catch(undefined),
  typeId: z.uuid().optional().catch(undefined),
  page: z.number().int().min(1).optional().catch(undefined),
});
type AssetSearch = z.infer<typeof searchSchema>;

export const assetsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/assets',
  validateSearch: searchSchema,
  component: AssetsPage,
});

function AssetsPage() {
  const search = assetsRoute.useSearch();
  const navigate = useNavigate({ from: '/assets' });
  const page = search.page ?? 1;
  const types = useQuery(assetTypesQuery);
  const list = useQuery(
    assetsQuery({
      q: search.q,
      status: search.status,
      typeId: search.typeId,
      page,
      pageSize: PAGE_SIZE,
    }),
  );

  /** Changes a filter and goes back to the first page. */
  function setFilter(changes: Partial<AssetSearch>) {
    void navigate({ search: (prev) => ({ ...prev, ...changes, page: undefined }), replace: true });
  }

  // Assets ticked for printing, kept across pages and filters until printed or cleared.
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  function toggle(ids: string[], on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  const data = list.data;
  const pageIds = data?.items.map((a) => a.id) ?? [];
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const typeCount = types.data?.length ?? 0;
  const first = data && data.total > 0 ? (page - 1) * PAGE_SIZE + 1 : 0;
  const last = data ? Math.min(page * PAGE_SIZE, data.total) : 0;

  return (
    <>
      <PageHeader
        title="Assets"
        caption={
          data &&
          types.data &&
          `${data.counts.all} ${data.counts.all === 1 ? 'asset' : 'assets'} across ${typeCount} ${typeCount === 1 ? 'type' : 'types'}`
        }
        actions={
          <>
            <Link
              to="/assets/labels"
              search={
                selected.size > 0
                  ? { ids: [...selected].join(',') }
                  : { q: search.q, status: search.status, typeId: search.typeId }
              }
              className={buttonClasses()}
              title={
                selected.size > 0
                  ? undefined
                  : 'Prints a tag for every asset that matches the search and filters'
              }
            >
              <QrCode aria-hidden="true" strokeWidth={1.75} />
              {selected.size > 0
                ? `Print ${selected.size} ${selected.size === 1 ? 'tag' : 'tags'}`
                : 'Print tags'}
            </Link>
            <Link to="/assets/import" className={buttonClasses()}>
              <Upload aria-hidden="true" strokeWidth={1.75} />
              Import
            </Link>
            <Link
              to="/assets/new"
              search={{ typeId: search.typeId }}
              className={buttonClasses('primary')}
            >
              <Plus aria-hidden="true" strokeWidth={1.75} />
              New asset
            </Link>
          </>
        }
      />

      {types.data && typeCount === 0 && (
        <p className="m-0 rounded-lg border border-line bg-surface-raised px-4 py-3">
          Assets belong to a type, such as Laptop or Phone, which sets their number prefix and
          fields. <Link to="/asset-types">Add an asset type</Link> to get started.
        </p>
      )}

      <StatusTabs
        current={search.status}
        counts={data?.counts}
        onChange={(status) => setFilter({ status })}
      />

      <div className="flex flex-wrap items-end gap-4">
        <SearchField value={search.q ?? ''} onChange={(q) => setFilter({ q: q || undefined })} />
        <TypeFilter
          value={search.typeId}
          types={types.data ?? []}
          onChange={(typeId) => setFilter({ typeId })}
        />
      </div>

      {selected.size > 0 && (
        <p className="m-0 flex flex-wrap items-center gap-3 type-caption text-ink-muted">
          {selected.size} selected for printing.
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear selection
          </Button>
        </p>
      )}

      <ErrorMessage error={list.error ?? types.error} />
      {list.isPending && <p className="m-0 text-ink-muted">Loading assets…</p>}
      {data && (
        <>
          <Table className="min-w-[640px]">
            <thead>
              <tr>
                <Th className="w-10">
                  <input
                    type="checkbox"
                    aria-label="Select every asset on this page for printing"
                    checked={allOnPage}
                    disabled={pageIds.length === 0}
                    onChange={(e) => toggle(pageIds, e.target.checked)}
                    className="size-4 cursor-pointer accent-pine"
                  />
                </Th>
                <Th>Asset</Th>
                <Th>Name</Th>
                <Th>Type</Th>
                <Th>Status</Th>
                <Th>Updated</Th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((asset) => (
                <tr key={asset.id}>
                  <Td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${asset.number} for printing`}
                      checked={selected.has(asset.id)}
                      onChange={(e) => toggle([asset.id], e.target.checked)}
                      className="size-4 cursor-pointer accent-pine"
                    />
                  </Td>
                  <Td className="whitespace-nowrap">
                    <Link
                      to="/assets/$assetId"
                      params={{ assetId: asset.id }}
                      className="type-id text-link"
                    >
                      {asset.number}
                    </Link>
                  </Td>
                  <Td>{asset.name}</Td>
                  <Td className="text-ink-muted">{asset.type.name}</Td>
                  <Td>
                    <StatusBadge tone={assetStatusTones[asset.status]}>
                      {assetStatusLabels[asset.status]}
                    </StatusBadge>
                  </Td>
                  <Td className="type-caption whitespace-nowrap text-ink-muted">
                    {formatDate(asset.updatedAt)}
                  </Td>
                </tr>
              ))}
              {data.items.length === 0 && (
                <tr>
                  <Td colSpan={6} className="text-ink-muted">
                    {search.q || search.status || search.typeId
                      ? 'No assets match these filters. Clear the search or choose another status or type.'
                      : 'No assets yet. Add one with New asset, or bring a spreadsheet in with Import.'}
                  </Td>
                </tr>
              )}
            </tbody>
          </Table>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="type-caption text-ink-muted">
              {data.total > 0 ? `Showing ${first}–${last} of ${data.total}` : 'Showing 0 assets'}
            </span>
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={page <= 1}
                onClick={() =>
                  void navigate({ search: (prev) => ({ ...prev, page: page - 1 || undefined }) })
                }
              >
                Previous
              </Button>
              <Button
                size="sm"
                disabled={last >= data.total}
                onClick={() => void navigate({ search: (prev) => ({ ...prev, page: page + 1 }) })}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </>
  );
}

function StatusTabs({
  current,
  counts,
  onChange,
}: {
  current: AssetStatus | undefined;
  counts: Record<'all' | AssetStatus, number> | undefined;
  onChange: (status: AssetStatus | undefined) => void;
}) {
  const tabs: { status: AssetStatus | undefined; label: string; count?: number }[] = [
    { status: undefined, label: 'All', count: counts?.all },
    ...ASSET_STATUSES.map((s) => ({ status: s, label: assetStatusLabels[s], count: counts?.[s] })),
  ];
  return (
    <div
      role="group"
      aria-label="Filter by status"
      className="flex flex-wrap gap-1 border-b border-line"
    >
      {tabs.map((tab) => {
        const on = tab.status === current;
        return (
          <button
            key={tab.label}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(tab.status)}
            className={cn(
              '-mb-px h-10 cursor-pointer border-0 border-b-2 border-transparent bg-transparent px-3 type-label text-ink',
              'focus-visible:shadow-focus focus-visible:outline-2 focus-visible:outline-transparent',
              on && 'border-pine font-semibold text-pine',
            )}
          >
            {tab.label}{' '}
            {tab.count !== undefined && (
              <span className="font-normal text-ink-muted">{tab.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Searches as you type, after a short pause, so each keystroke does not hit the server. */
function SearchField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const id = useId();
  const [text, setText] = useState(value);
  // Follow the address when it changes from elsewhere, such as the back button.
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    setText(value);
  }
  useEffect(() => {
    if (text.trim() === value) return;
    const timer = setTimeout(() => onChange(text.trim()), 300);
    return () => clearTimeout(timer);
  }, [text, value, onChange]);

  return (
    <div className="flex flex-[3_1_280px] flex-col gap-2">
      <Label htmlFor={id}>Search</Label>
      <Input
        id={id}
        type="search"
        placeholder="Asset number, name or field value"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
    </div>
  );
}

function TypeFilter({
  value,
  types,
  onChange,
}: {
  value: string | undefined;
  types: { id: string; name: string }[];
  onChange: (typeId: string | undefined) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-[1_1_160px] flex-col gap-2">
      <Label htmlFor={id}>Type</Label>
      <Select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">All types</option>
        {types.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </Select>
    </div>
  );
}
