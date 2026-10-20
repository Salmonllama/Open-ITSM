import { assetSchema, type Asset } from '@open-itsm/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createRoute, useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { FormField } from '@/components/form-field';
import { PageHeader } from '@/components/page-header';
import { QrCamera } from '@/components/qr-camera';
import { Button } from '@/components/ui/button';
import { Card, ErrorMessage } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { StatusBadge } from '@/components/ui/status-badge';
import { apiRequest } from '@/lib/api';
import { assetStatusLabels, assetStatusTones } from '@/lib/assets';
import { assetHistoryQuery, assetQuery, assignmentSuggestionsQuery } from '@/lib/queries';
import { parseScan } from '@/lib/scan';
import { cn } from '@/lib/utils';
import { authedRoute } from './authed';

const NOT_A_TAG =
  'That code is not an Open ITSM asset tag. Scan the QR code on the tag, or type its asset number.';

function lookUp(number: string) {
  return apiRequest('GET', `/api/assets/by-number/${encodeURIComponent(number)}`, {
    schema: assetSchema,
  });
}

/** Where a tag's QR code points (`/a/<asset number>`): opens that asset. */
export const tagRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/a/$',
  component: TagRedirect,
});

function TagRedirect() {
  const navigate = useNavigate();
  // Read the raw address so a number with an encoded slash (OLD%2F42) survives intact.
  const number = parseScan(window.location.href);
  const asset = useQuery({
    queryKey: ['assets', 'by-number', number],
    queryFn: () => lookUp(number ?? ''),
    enabled: number !== null,
    retry: false,
  });

  useEffect(() => {
    if (asset.data) {
      void navigate({
        to: '/assets/$assetId',
        params: { assetId: asset.data.id },
        replace: true,
      });
    }
  }, [asset.data, navigate]);

  if (number !== null && !asset.error) return <p className="m-0 text-ink-muted">Opening asset…</p>;
  return (
    <>
      <PageHeader title="Asset not found" />
      <ErrorMessage error={asset.error ?? NOT_A_TAG} />
      <p className="m-0">
        <Link to="/scan">Scan another tag</Link> or <Link to="/assets">search the assets</Link>.
      </p>
    </>
  );
}

const MODES = ['open', 'check-out', 'check-in'] as const;
type Mode = (typeof MODES)[number];
const modeLabels: Record<Mode, string> = {
  open: 'Open asset',
  'check-out': 'Check out',
  'check-in': 'Check in',
};
const modeHints: Record<Mode, string> = {
  open: 'Each scan opens that asset’s page.',
  'check-out':
    'Each scan assigns the asset to the person or location below and sets it to Deployed. Scan as many as you need.',
  'check-in':
    'Each scan returns the asset and sets it to In stock. Scan as many as you need. To retire an asset, open it instead.',
};

type Outcome = {
  key: number;
  text: string;
  asset?: Asset;
  ok: boolean;
  message: string;
};

export const scanRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/scan',
  component: ScanPage,
});

/**
 * The camera sees a code on every frame, so a code is handled once while it stays in view. Taking
 * it out of view for this long, then showing it again, scans it again.
 */
const OUT_OF_VIEW_MS = 1500;

function ScanPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const fieldId = useId();
  const assigneesId = useId();
  const locationsId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<Mode>('open');
  const [assignee, setAssignee] = useState('');
  const [location, setLocation] = useState('');
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [busy, setBusy] = useState(false);
  const last = useRef<{ text: string; seenAt: number }>({ text: '', seenAt: 0 });
  const nextKey = useRef(0);
  const suggestions = useQuery({ ...assignmentSuggestionsQuery, enabled: mode === 'check-out' });

  const record = useCallback((outcome: Omit<Outcome, 'key'>) => {
    setOutcomes((prev) => [{ ...outcome, key: nextKey.current++ }, ...prev].slice(0, 50));
  }, []);

  const handle = useCallback(
    async (text: string) => {
      const number = parseScan(text);
      if (number === null) {
        record({ text, ok: false, message: NOT_A_TAG });
        return;
      }
      if (mode === 'check-out' && assignee.trim() === '' && location.trim() === '') {
        record({
          text: number,
          ok: false,
          message: 'Enter a person, a location or both before you scan to check out.',
        });
        return;
      }
      setBusy(true);
      try {
        const asset = await lookUp(number);
        if (mode === 'open') {
          await navigate({ to: '/assets/$assetId', params: { assetId: asset.id } });
          return;
        }
        let saved: Asset;
        if (mode === 'check-out') {
          if (asset.status === 'deployed') {
            record({
              text: number,
              asset,
              ok: false,
              message: 'Already checked out. Check it in first, or open it to reassign.',
            });
            return;
          }
          saved = await apiRequest('POST', `/api/assets/${asset.id}/assign`, {
            body: { assignee: assignee.trim(), location: location.trim() },
            schema: assetSchema,
          });
        } else {
          if (asset.status !== 'deployed') {
            record({
              text: number,
              asset,
              ok: false,
              message: 'Not checked out, so there is nothing to check in.',
            });
            return;
          }
          saved = await apiRequest('POST', `/api/assets/${asset.id}/return`, {
            body: { status: 'in_stock' },
            schema: assetSchema,
          });
        }
        queryClient.setQueryData(assetQuery(saved.id).queryKey, saved);
        record({
          text: number,
          asset: saved,
          ok: true,
          message:
            mode === 'check-out'
              ? `Checked out to ${[assignee.trim(), location.trim()].filter(Boolean).join(', ')}.`
              : 'Checked in.',
        });
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: assetHistoryQuery(saved.id).queryKey }),
          queryClient.invalidateQueries({ queryKey: ['assets', 'list'] }),
          queryClient.invalidateQueries({ queryKey: assignmentSuggestionsQuery.queryKey }),
        ]);
      } catch (error) {
        record({
          text: number,
          ok: false,
          message: error instanceof Error ? error.message : 'The scan failed. Try again.',
        });
      } finally {
        setBusy(false);
      }
    },
    [mode, assignee, location, navigate, queryClient, record],
  );

  const onCameraCode = useCallback(
    (text: string) => {
      const now = Date.now();
      const repeat = text === last.current.text && now - last.current.seenAt < OUT_OF_VIEW_MS;
      last.current = { text, seenAt: now };
      if (!repeat) void handle(text);
    },
    [handle],
  );

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = inputRef.current;
    if (!input || input.value.trim() === '') return;
    const text = input.value;
    input.value = '';
    void handle(text);
  }

  return (
    <>
      <PageHeader
        title="Scan"
        caption="Scan an asset tag with this device’s camera or a USB scanner, or type an asset number."
      />

      <div
        role="radiogroup"
        aria-label="What a scan does"
        className="flex flex-wrap gap-1 border-b border-line"
      >
        {MODES.map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            onClick={() => {
              setMode(m);
              // A tag still in front of the camera is scanned again in the new mode.
              last.current = { text: '', seenAt: 0 };
              inputRef.current?.focus();
            }}
            className={cn(
              '-mb-px h-10 cursor-pointer border-0 border-b-2 border-transparent bg-transparent px-3 type-label text-ink',
              'focus-visible:shadow-focus focus-visible:outline-2 focus-visible:outline-transparent',
              mode === m && 'border-pine font-semibold text-pine',
            )}
          >
            {modeLabels[m]}
          </button>
        ))}
      </div>
      <p className="m-0 text-ink-muted">{modeHints[mode]}</p>

      {mode === 'check-out' && (
        <Card className="grid gap-4 sm:grid-cols-2">
          <FormField
            label="Person"
            name="assignee"
            autoComplete="off"
            maxLength={200}
            list={assigneesId}
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
            hint="Who gets the assets, like Priya Nair · Finance."
          />
          <FormField
            label="Location"
            name="location"
            autoComplete="off"
            maxLength={200}
            list={locationsId}
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            hint="Where they go, like HQ, 3rd floor. Enter a person, a location or both."
          />
          <datalist id={assigneesId}>
            {suggestions.data?.assignees.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
          <datalist id={locationsId}>
            {suggestions.data?.locations.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </Card>
      )}

      <form className="flex max-w-xl flex-col gap-2" onSubmit={onSubmit}>
        <Label htmlFor={fieldId}>Asset number or tag</Label>
        <div className="flex gap-2">
          <Input
            ref={inputRef}
            id={fieldId}
            mono
            autoFocus
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            enterKeyHint="go"
            aria-describedby={`${fieldId}-hint`}
            className="min-w-0 flex-1"
          />
          <Button type="submit" variant="primary" disabled={busy}>
            {mode === 'open' ? 'Open' : modeLabels[mode]}
          </Button>
        </div>
        <p id={`${fieldId}-hint`} className="m-0 type-caption text-ink-muted">
          A USB scanner types the tag into this field and presses Enter for you.
        </p>
      </form>

      <QrCamera onCode={onCameraCode} />

      {outcomes.length > 0 && (
        <section aria-labelledby="scans-heading" className="flex flex-col gap-3">
          <h2 id="scans-heading" className="m-0 type-heading">
            Scans
          </h2>
          <ul aria-live="polite" className="m-0 flex list-none flex-col gap-2 p-0">
            {outcomes.map((o) => (
              <li
                key={o.key}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-line bg-surface-raised px-3 py-2"
              >
                {o.asset ? (
                  <Link
                    to="/assets/$assetId"
                    params={{ assetId: o.asset.id }}
                    className="type-id text-link"
                  >
                    {o.asset.number}
                  </Link>
                ) : (
                  <span className="type-id break-all text-ink-muted">{o.text}</span>
                )}
                {o.asset && <span>{o.asset.name}</span>}
                {o.asset && (
                  <StatusBadge tone={assetStatusTones[o.asset.status]}>
                    {assetStatusLabels[o.asset.status]}
                  </StatusBadge>
                )}
                <span
                  className={cn('basis-full type-caption', o.ok ? 'text-success' : 'text-danger')}
                >
                  {o.message}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
