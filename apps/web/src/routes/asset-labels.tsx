import {
  assetListResponseSchema,
  assetSchema,
  assetStatusSchema,
  type AssetSummary,
} from '@open-itsm/shared';
import { useQuery } from '@tanstack/react-query';
import { Link, createRoute, useNavigate } from '@tanstack/react-router';
import { Printer } from 'lucide-react';
import { useId } from 'react';
import { z } from 'zod';
import { AssetTag } from '@/components/asset-tag';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { ErrorMessage } from '@/components/ui/card';
import { Label, Select } from '@/components/ui/input';
import { apiRequest } from '@/lib/api';
import {
  LABEL_LAYOUTS,
  labelLayouts,
  storeLabelLayout,
  storedLabelLayout,
  toPages,
  type LabelLayout,
} from '@/lib/labels';
import { authedRoute } from './authed';

/** More tags than this in one print is almost always a mistake; narrow the filters instead. */
const MAX_LABELS = 1000;

const searchSchema = z.object({
  /** Comma-separated asset IDs; without it, every asset matching the filters below. */
  ids: z.string().optional().catch(undefined),
  q: z.string().optional().catch(undefined),
  status: assetStatusSchema.optional().catch(undefined),
  typeId: z.uuid().optional().catch(undefined),
  layout: z.enum(LABEL_LAYOUTS).optional().catch(undefined),
});
type LabelSearch = z.infer<typeof searchSchema>;

export const assetLabelsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/assets/labels',
  validateSearch: searchSchema,
  component: LabelsPage,
});

async function fetchTags(search: LabelSearch): Promise<{ items: AssetSummary[]; total: number }> {
  if (search.ids) {
    const ids = [...new Set(search.ids.split(','))]
      .filter((id) => z.uuid().safeParse(id).success)
      .slice(0, MAX_LABELS);
    const items = await Promise.all(
      ids.map((id) => apiRequest('GET', `/api/assets/${id}`, { schema: assetSchema })),
    );
    return { items, total: items.length };
  }
  const items: AssetSummary[] = [];
  let total = 0;
  for (let page = 1; items.length < MAX_LABELS; page++) {
    const params = new URLSearchParams({ page: String(page), pageSize: '100' });
    for (const key of ['q', 'status', 'typeId'] as const) {
      const value = search[key];
      if (value) params.set(key, value);
    }
    const res = await apiRequest('GET', `/api/assets?${params}`, {
      schema: assetListResponseSchema,
    });
    total = res.total;
    items.push(...res.items);
    if (items.length >= total || res.items.length === 0) break;
  }
  return { items: items.slice(0, MAX_LABELS), total };
}

function LabelsPage() {
  const search = assetLabelsRoute.useSearch();
  const navigate = useNavigate({ from: '/assets/labels' });
  const layoutId = useId();
  const layout = search.layout ?? storedLabelLayout();
  const { ids, q, status, typeId } = search;
  const tags = useQuery({
    queryKey: ['assets', 'labels', { ids, q, status, typeId }],
    queryFn: () => fetchTags({ ids, q, status, typeId }),
  });

  function setLayout(next: LabelLayout) {
    storeLabelLayout(next);
    void navigate({ search: (prev) => ({ ...prev, layout: next }), replace: true });
  }

  const items = tags.data?.items ?? [];
  const pages = toPages(items, layout);
  const info = labelLayouts[layout];
  const count = `${items.length} ${items.length === 1 ? 'tag' : 'tags'}`;
  const caption =
    tags.data &&
    (layout === 'roll'
      ? count
      : `${count} on ${pages.length} ${pages.length === 1 ? 'sheet' : 'sheets'}`);

  return (
    <>
      {/* The page size follows the layout; Chrome and Edge preselect it in the print dialog. */}
      <style>{`@page { size: ${info.pageSize}; margin: 0; }`}</style>
      <div className="flex flex-col gap-6 print:hidden">
        <nav aria-label="Breadcrumb" className="type-caption text-ink-muted">
          <Link to="/assets" activeOptions={{ exact: true }}>
            Assets
          </Link>{' '}
          <span aria-hidden="true">/</span> Print labels
        </nav>
        <PageHeader
          title="Print labels"
          caption={caption}
          actions={
            <Button variant="primary" disabled={items.length === 0} onClick={() => window.print()}>
              <Printer aria-hidden="true" strokeWidth={1.75} />
              Print
            </Button>
          }
        />
        <div className="flex max-w-xl flex-col gap-2">
          <Label htmlFor={layoutId}>Layout</Label>
          <Select
            id={layoutId}
            value={layout}
            onChange={(e) => setLayout(e.target.value as LabelLayout)}
            aria-describedby={`${layoutId}-hint`}
          >
            {LABEL_LAYOUTS.map((l) => (
              <option key={l} value={l}>
                {labelLayouts[l].label}
              </option>
            ))}
          </Select>
          <p id={`${layoutId}-hint`} className="m-0 type-caption text-ink-muted">
            {info.hint}
          </p>
        </div>
        <ErrorMessage error={tags.error} />
        {tags.isPending && <p className="m-0 text-ink-muted">Loading assets…</p>}
        {tags.data && items.length === 0 && (
          <p className="m-0 text-ink-muted">
            No assets match, so there is nothing to print. Go back to{' '}
            <Link to="/assets">Assets</Link> and change the filters.
          </p>
        )}
        {tags.data && tags.data.total > items.length && (
          <p className="m-0 rounded-md bg-warning-soft px-3 py-2 text-warning" role="status">
            {tags.data.total} assets match, and one print holds at most {MAX_LABELS} tags. These are
            the first {MAX_LABELS}; narrow the filters to print the rest.
          </p>
        )}
      </div>

      {layout === 'roll' ? (
        <div className="flex flex-wrap gap-4 print:block">
          {items.map((a) => (
            <div key={a.id} className="label-roll-item">
              <AssetTag number={a.number} typeName={a.type.name} name={a.name} />
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-6 overflow-x-auto print:block print:overflow-visible">
          {pages.map((page, i) => (
            <div
              key={i}
              className={`label-sheet label-sheet-${layout}`}
              aria-label={`Sheet ${i + 1}`}
            >
              {page.map((a) => (
                <AssetTag key={a.id} number={a.number} typeName={a.type.name} name={a.name} />
              ))}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
