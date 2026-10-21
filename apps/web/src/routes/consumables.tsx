import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createRoute, useNavigate } from '@tanstack/react-router';
import { Minus, PackagePlus, Pencil, Plus, Tally5, Trash2 } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { z } from 'zod';
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  ConsumableFormDialog,
  StockDialog,
  type StockAction,
} from '@/components/consumable-dialogs';
import { LowStockBadge } from '@/components/low-stock';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, ErrorMessage } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { Table, Td, Th } from '@/components/ui/table';
import { apiRequest } from '@/lib/api';
import { formatDate } from '@/lib/assets';
import { adjustmentLabels, formatChange } from '@/lib/consumables';
import { consumableQuery, consumablesQuery } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { authedRoute } from './authed';

const PAGE_SIZE = 25;

const searchSchema = z.object({
  q: z.string().optional().catch(undefined),
  low: z.boolean().optional().catch(undefined),
  page: z.number().int().min(1).optional().catch(undefined),
});
type ConsumableSearch = z.infer<typeof searchSchema>;

export const consumablesRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/consumables',
  validateSearch: searchSchema,
  component: ConsumablesPage,
});

export const consumableViewRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/consumables/$consumableId',
  component: ConsumablePage,
});

function ConsumablesPage() {
  const search = consumablesRoute.useSearch();
  const navigate = useNavigate({ from: '/consumables' });
  const page = search.page ?? 1;
  const [creating, setCreating] = useState(false);
  const list = useQuery(
    consumablesQuery({
      q: search.q,
      low: search.low ? 'true' : undefined,
      page,
      pageSize: PAGE_SIZE,
    }),
  );

  function setFilter(changes: Partial<ConsumableSearch>) {
    void navigate({ search: (prev) => ({ ...prev, ...changes, page: undefined }), replace: true });
  }

  const data = list.data;
  const first = data && data.total > 0 ? (page - 1) * PAGE_SIZE + 1 : 0;
  const last = data ? Math.min(page * PAGE_SIZE, data.total) : 0;

  return (
    <>
      <PageHeader
        title="Consumables"
        caption="Parts and supplies counted by quantity, like toner, cables and batteries."
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus aria-hidden="true" strokeWidth={1.75} />
            New consumable
          </Button>
        }
      />

      <div
        role="group"
        aria-label="Filter by stock"
        className="flex flex-wrap gap-1 border-b border-line"
      >
        {[
          { low: false, label: 'All', count: data?.allCount },
          { low: true, label: 'Low stock', count: data?.lowCount },
        ].map((tab) => {
          const on = tab.low === !!search.low;
          return (
            <button
              key={tab.label}
              type="button"
              aria-pressed={on}
              onClick={() => setFilter({ low: tab.low || undefined })}
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

      <SearchField value={search.q ?? ''} onChange={(q) => setFilter({ q: q || undefined })} />

      <ErrorMessage error={list.error} />
      {list.isPending && <p className="m-0 text-ink-muted">Loading consumables…</p>}
      {data && (
        <>
          <Table className="min-w-[560px]">
            <thead>
              <tr>
                <Th>Name</Th>
                <Th className="text-right">In stock</Th>
                <Th className="text-right">Low at</Th>
                <Th>Status</Th>
                <Th>Updated</Th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((c) => (
                <tr key={c.id}>
                  <Td>
                    <Link to="/consumables/$consumableId" params={{ consumableId: c.id }}>
                      {c.name}
                    </Link>
                  </Td>
                  <Td className="text-right tabular-nums">{c.quantity}</Td>
                  <Td className="text-right text-ink-muted tabular-nums">
                    {c.lowStockThreshold > 0 ? c.lowStockThreshold : '—'}
                  </Td>
                  <Td>{c.low && <LowStockBadge />}</Td>
                  <Td className="type-caption whitespace-nowrap text-ink-muted">
                    {formatDate(c.updatedAt)}
                  </Td>
                </tr>
              ))}
              {data.items.length === 0 && (
                <tr>
                  <Td colSpan={5} className="text-ink-muted">
                    {search.q || search.low
                      ? 'No consumables match. Clear the search or show all.'
                      : 'No consumables yet. Add toner, cables or spare parts with New consumable.'}
                  </Td>
                </tr>
              )}
            </tbody>
          </Table>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="type-caption text-ink-muted">
              {data.total > 0
                ? `Showing ${first}–${last} of ${data.total}`
                : 'Showing 0 consumables'}
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

      <ConsumableFormDialog
        open={creating}
        onClose={() => setCreating(false)}
        onSaved={(saved) =>
          void navigate({ to: '/consumables/$consumableId', params: { consumableId: saved.id } })
        }
      />
    </>
  );
}

/** Searches as you type, after a short pause, so each keystroke does not hit the server. */
function SearchField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const id = useId();
  const [text, setText] = useState(value);
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
    <div className="flex max-w-xl flex-col gap-2">
      <Label htmlFor={id}>Search</Label>
      <Input
        id={id}
        type="search"
        placeholder="Name"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
    </div>
  );
}

function ConsumablePage() {
  const { consumableId } = consumableViewRoute.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const item = useQuery(consumableQuery(consumableId));
  const [editing, setEditing] = useState(false);
  const [action, setAction] = useState<StockAction | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const remove = useMutation({
    mutationFn: () => apiRequest('DELETE', `/api/consumables/${consumableId}`),
    onSuccess: async () => {
      setConfirmingDelete(false);
      await navigate({ to: '/consumables' });
      queryClient.removeQueries({ queryKey: ['consumables', consumableId] });
      await queryClient.invalidateQueries({ queryKey: ['consumables'] });
    },
  });

  if (item.isPending) return <p className="m-0 text-ink-muted">Loading consumable…</p>;
  if (item.error) return <ErrorMessage error={item.error} />;
  const c = item.data;

  return (
    <>
      <nav aria-label="Breadcrumb" className="type-caption text-ink-muted">
        <Link to="/consumables" activeOptions={{ exact: true }}>
          Consumables
        </Link>{' '}
        <span aria-hidden="true">/</span> {c.name}
      </nav>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="m-0 type-title">{c.name}</h1>
          <div className="flex flex-wrap items-center gap-3">
            {c.low && <LowStockBadge />}
            <span className="type-caption text-ink-muted">updated {formatDate(c.updatedAt)}</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" onClick={() => setEditing(true)}>
            <Pencil aria-hidden="true" strokeWidth={1.75} />
            Edit
          </Button>
          {c.deletable && (
            <Button variant="danger" onClick={() => setConfirmingDelete(true)}>
              <Trash2 aria-hidden="true" strokeWidth={1.75} />
              Delete
            </Button>
          )}
          <Button onClick={() => setAction('count')}>
            <Tally5 aria-hidden="true" strokeWidth={1.75} />
            Count
          </Button>
          <Button disabled={c.quantity === 0} onClick={() => setAction('use')}>
            <Minus aria-hidden="true" strokeWidth={1.75} />
            Use
          </Button>
          <Button variant="primary" onClick={() => setAction('add')}>
            <PackagePlus aria-hidden="true" strokeWidth={1.75} />
            Add stock
          </Button>
        </div>
      </header>

      <div className="flex flex-wrap items-start gap-6">
        <section
          aria-labelledby="h-stock-history"
          className="flex min-w-0 flex-[999_1_520px] flex-col gap-3"
        >
          <h2 id="h-stock-history" className="m-0 type-heading">
            Stock history
          </h2>
          <Table className="min-w-[560px]">
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Change</Th>
                <Th className="text-right">Amount</Th>
                <Th className="text-right">In stock</Th>
                <Th>Reason</Th>
                <Th>By</Th>
              </tr>
            </thead>
            <tbody>
              {c.adjustments.map((a) => (
                <tr key={a.id}>
                  <Td className="whitespace-nowrap">{formatDate(a.at)}</Td>
                  <Td>{adjustmentLabels[a.kind]}</Td>
                  <Td className="text-right tabular-nums">
                    {a.kind === 'created' ? a.change : formatChange(a.change)}
                  </Td>
                  <Td className="text-right tabular-nums">{a.quantityAfter}</Td>
                  <Td>
                    {a.repair ? (
                      <span className="flex flex-col">
                        <span>
                          Repair on{' '}
                          <Link
                            to="/assets/$assetId"
                            params={{ assetId: a.repair.asset.id }}
                            className="type-id"
                          >
                            {a.repair.asset.number}
                          </Link>
                          : {a.repair.summary}
                        </span>
                        {a.reason && (
                          <span className="type-caption text-ink-muted">{a.reason}</span>
                        )}
                      </span>
                    ) : (
                      a.reason || <span className="text-ink-muted">—</span>
                    )}
                  </Td>
                  <Td className="text-ink-muted">{a.by?.name ?? 'System'}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </section>
        <aside className="flex min-w-0 flex-[1_1_260px] flex-col gap-6">
          <Card className="flex flex-col gap-4">
            <h2 className="m-0 type-heading">Stock</h2>
            <dl className="m-0 grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-1">
                <dt className="type-caption text-ink-muted">In stock</dt>
                <dd className="m-0 type-title tabular-nums">{c.quantity}</dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="type-caption text-ink-muted">Low at</dt>
                <dd className="m-0 type-title tabular-nums">
                  {c.lowStockThreshold > 0 ? c.lowStockThreshold : '—'}
                </dd>
              </div>
            </dl>
            <p className="m-0 type-caption text-ink-muted">
              {c.lowStockThreshold > 0
                ? `Flagged as low when ${c.lowStockThreshold} or fewer are left.`
                : 'Never flagged as low. Edit it to set a threshold.'}
            </p>
          </Card>
        </aside>
      </div>

      <ConsumableFormDialog open={editing} consumable={c} onClose={() => setEditing(false)} />
      <StockDialog action={action} consumable={c} onClose={() => setAction(null)} />
      <ConfirmDialog
        open={confirmingDelete}
        title={`Delete ${c.name}?`}
        confirmLabel="Delete consumable"
        danger
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
        onCancel={() => {
          setConfirmingDelete(false);
          remove.reset();
        }}
      >
        <p className="m-0">
          It is removed for good. The audit log keeps a record that you deleted it. Use this for
          consumables added by mistake.
        </p>
        {confirmingDelete && <ErrorMessage error={remove.error} />}
      </ConfirmDialog>
    </>
  );
}
