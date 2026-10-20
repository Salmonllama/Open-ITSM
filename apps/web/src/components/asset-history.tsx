import {
  SETTABLE_ASSET_STATUSES,
  assetSchema,
  type Actor,
  type Asset,
  type AssetEvent,
  type AssetHistory,
  type Repair,
} from '@open-itsm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MapPin, User } from 'lucide-react';
import { useId, useState } from 'react';
import { apiRequest } from '@/lib/api';
import { assetStatusLabels, formatDate } from '@/lib/assets';
import { assetHistoryQuery, assetQuery, assignmentSuggestionsQuery } from '@/lib/queries';
import { FormField } from './form-field';
import { FormDialog } from './form-dialog';
import { Card } from './ui/card';
import { Label, Select } from './ui/input';
import { Table, Td, Th } from './ui/table';

const textareaClasses =
  'rounded-md border border-line-strong bg-surface-raised px-3 py-2 type-body text-ink focus-visible:shadow-focus focus-visible:outline-2 focus-visible:outline-transparent';

function byLine(actor: Actor | null): string {
  return actor ? actor.name : 'System';
}

function text(form: FormData, name: string): string {
  return String(form.get(name) ?? '').trim();
}

/** A POST to one of the asset's history endpoints that refreshes the asset and its history. */
function useAssetAction(assetId: string, onDone: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ path, body }: { path: string; body: object }) =>
      apiRequest('POST', `/api/assets/${assetId}${path}`, { body, schema: assetSchema }),
    onSuccess: async (saved) => {
      queryClient.setQueryData(assetQuery(assetId).queryKey, saved);
      onDone();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: assetHistoryQuery(assetId).queryKey }),
        queryClient.invalidateQueries({ queryKey: ['assets', 'list'] }),
        queryClient.invalidateQueries({ queryKey: assignmentSuggestionsQuery.queryKey }),
      ]);
    },
  });
}

function NotesField({
  label,
  hint,
  defaultValue,
}: {
  label: string;
  hint?: string;
  defaultValue?: string;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <textarea
        id={id}
        name="notes"
        rows={3}
        maxLength={4000}
        defaultValue={defaultValue}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className={textareaClasses}
      />
      {hint && (
        <p id={`${id}-hint`} className="m-0 type-caption text-ink-muted">
          {hint}
        </p>
      )}
    </div>
  );
}

export type AssetDialog = 'assign' | 'return' | 'repair' | 'close-repair' | 'status' | null;

/** The dialogs behind the asset page's actions. Each one closes itself when it succeeds. */
export function AssetActionDialogs({
  asset,
  openRepair,
  dialog,
  onClose,
}: {
  asset: Asset;
  openRepair: Repair | undefined;
  dialog: AssetDialog;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const suggestions = useQuery({ ...assignmentSuggestionsQuery, enabled: dialog === 'assign' });
  const assigneesId = useId();
  const locationsId = useId();
  const statusId = useId();
  const returnId = useId();
  const [assignProblem, setAssignProblem] = useState<string>();

  const assign = useAssetAction(asset.id, onClose);
  const giveBack = useAssetAction(asset.id, onClose);
  const repair = useAssetAction(asset.id, onClose);
  const closeRepair = useAssetAction(asset.id, onClose);
  const changeStatus = useMutation({
    mutationFn: (status: string) =>
      apiRequest('PATCH', `/api/assets/${asset.id}`, { body: { status }, schema: assetSchema }),
    onSuccess: async (saved) => {
      queryClient.setQueryData(assetQuery(asset.id).queryKey, saved);
      onClose();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: assetHistoryQuery(asset.id).queryKey }),
        queryClient.invalidateQueries({ queryKey: ['assets', 'list'] }),
      ]);
    },
  });

  function cancel() {
    for (const m of [assign, giveBack, repair, closeRepair, changeStatus]) m.reset();
    setAssignProblem(undefined);
    onClose();
  }

  const reassigning = asset.status === 'deployed';

  return (
    <>
      <FormDialog
        open={dialog === 'assign'}
        title={reassigning ? `Reassign ${asset.number}` : `Assign ${asset.number}`}
        submitLabel={reassigning ? 'Reassign' : 'Assign'}
        pending={assign.isPending}
        error={assignProblem ?? assign.error}
        onCancel={cancel}
        onSubmit={(form) => {
          const body = {
            assignee: text(form, 'assignee'),
            location: text(form, 'location'),
            notes: text(form, 'notes'),
          };
          if (body.assignee === '' && body.location === '') {
            setAssignProblem('Enter a person, a location or both.');
            return;
          }
          setAssignProblem(undefined);
          assign.mutate({ path: '/assign', body });
        }}
      >
        <p className="m-0 type-body text-ink-muted">
          {reassigning
            ? 'The current assignment ends now and a new one starts. The status stays Deployed.'
            : 'The status changes to Deployed.'}
        </p>
        <FormField
          label="Person"
          name="assignee"
          autoComplete="off"
          maxLength={200}
          list={assigneesId}
          hint="Who has it, like Priya Nair · Finance."
        />
        <FormField
          label="Location"
          name="location"
          autoComplete="off"
          maxLength={200}
          list={locationsId}
          hint="Where it is, like HQ, 3rd floor. Enter a person, a location or both."
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
        <NotesField label="Notes (optional)" />
      </FormDialog>

      <FormDialog
        open={dialog === 'return'}
        title={`Return ${asset.number}`}
        submitLabel="Return asset"
        pending={giveBack.isPending}
        error={giveBack.error}
        onCancel={cancel}
        onSubmit={(form) =>
          giveBack.mutate({
            path: '/return',
            body: { status: text(form, 'status'), notes: text(form, 'notes') },
          })
        }
      >
        <p className="m-0 type-body text-ink-muted">The current assignment ends now.</p>
        <div className="flex flex-col gap-2">
          <Label htmlFor={returnId}>New status</Label>
          <Select id={returnId} name="status" defaultValue="in_stock">
            <option value="in_stock">{assetStatusLabels.in_stock}</option>
            <option value="retired">{assetStatusLabels.retired}</option>
          </Select>
        </div>
        <NotesField label="Notes (optional)" />
      </FormDialog>

      <FormDialog
        open={dialog === 'repair'}
        title={`Log a repair for ${asset.number}`}
        submitLabel="Log repair"
        pending={repair.isPending}
        error={repair.error}
        onCancel={cancel}
        onSubmit={(form) =>
          repair.mutate({
            path: '/repairs',
            body: { summary: text(form, 'summary'), notes: text(form, 'notes') },
          })
        }
      >
        <p className="m-0 type-body text-ink-muted">
          The status changes to In repair until you close the repair.
          {reassigning && ' The asset stays assigned.'}
        </p>
        <FormField
          label="Repair"
          name="summary"
          required
          autoComplete="off"
          maxLength={200}
          hint="What is being fixed, like Battery replaced."
        />
        <NotesField label="Notes (optional)" hint="What is wrong and who is fixing it." />
      </FormDialog>

      <FormDialog
        open={dialog === 'close-repair' && openRepair !== undefined}
        title={`Close repair: ${openRepair?.summary ?? ''}`}
        submitLabel="Close repair"
        pending={closeRepair.isPending}
        error={closeRepair.error}
        onCancel={cancel}
        onSubmit={(form) => {
          if (!openRepair) return;
          closeRepair.mutate({
            path: `/repairs/${openRepair.id}/close`,
            body: { notes: text(form, 'notes') },
          });
        }}
      >
        <p className="m-0 type-body text-ink-muted">
          The asset goes back to the status it had before the repair.
        </p>
        <NotesField
          label="Notes"
          defaultValue={openRepair?.notes}
          hint="Record the outcome, like Replaced in house."
        />
      </FormDialog>

      <FormDialog
        open={dialog === 'status'}
        title={`Change the status of ${asset.number}`}
        submitLabel="Change status"
        pending={changeStatus.isPending}
        error={changeStatus.error}
        onCancel={cancel}
        onSubmit={(form) => changeStatus.mutate(text(form, 'status'))}
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor={statusId}>Status</Label>
          <Select id={statusId} name="status" defaultValue={asset.status}>
            {SETTABLE_ASSET_STATUSES.map((s) => (
              <option key={s} value={s}>
                {assetStatusLabels[s]}
              </option>
            ))}
          </Select>
          <p className="m-0 type-caption text-ink-muted">
            Assign the asset to deploy it, or log a repair to set it to In repair.
          </p>
        </div>
      </FormDialog>
    </>
  );
}

/** The side card: who or where the asset is now. */
export function CurrentAssignmentCard({ history }: { history: AssetHistory | undefined }) {
  const current = history?.assignments.find((a) => a.endedAt === null);
  return (
    <Card className="flex flex-col gap-2">
      <h2 className="m-0 type-heading">Assigned to</h2>
      {!current ? (
        <p className="m-0 text-ink-muted">Not assigned.</p>
      ) : (
        <div className="flex gap-3">
          {current.assignee ? (
            <User
              aria-hidden="true"
              strokeWidth={1.75}
              className="mt-px size-5 shrink-0 text-ink-muted"
            />
          ) : (
            <MapPin
              aria-hidden="true"
              strokeWidth={1.75}
              className="mt-px size-5 shrink-0 text-ink-muted"
            />
          )}
          <span className="flex flex-col">
            <span>{current.assignee || current.location}</span>
            <span className="type-caption text-ink-muted">
              {current.assignee && current.location ? `${current.location} · ` : ''}since{' '}
              {formatDate(current.startedAt)}
            </span>
            {current.notes && <span className="type-caption text-ink-muted">{current.notes}</span>}
          </span>
        </div>
      )}
    </Card>
  );
}

export function AssignmentHistoryCard({ history }: { history: AssetHistory | undefined }) {
  return (
    <section aria-labelledby="h-assignments" className="flex flex-col gap-3">
      <h2 id="h-assignments" className="m-0 type-heading">
        Assignment history
      </h2>
      {history && history.assignments.length === 0 ? (
        <p className="m-0 text-ink-muted">This asset has never been assigned.</p>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Assigned to</Th>
              <Th>Location</Th>
              <Th>From</Th>
              <Th>To</Th>
              <Th>By</Th>
            </tr>
          </thead>
          <tbody>
            {history?.assignments.map((a) => (
              <tr key={a.id}>
                <Td>{a.assignee || '—'}</Td>
                <Td className="text-ink-muted">{a.location || '—'}</Td>
                <Td className="whitespace-nowrap">{formatDate(a.startedAt)}</Td>
                <Td className="whitespace-nowrap">{a.endedAt ? formatDate(a.endedAt) : 'Now'}</Td>
                <Td className="text-ink-muted">{byLine(a.startedBy)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  );
}

export function RepairsCard({ history }: { history: AssetHistory | undefined }) {
  return (
    <Card className="flex flex-col gap-4">
      <h2 className="m-0 type-heading">Repairs</h2>
      {history && history.repairs.length === 0 && (
        <p className="m-0 text-ink-muted">No repairs logged.</p>
      )}
      {history?.repairs.map((r, i) => (
        <div
          key={r.id}
          className={
            i > 0 ? 'flex flex-col gap-1 border-t border-line pt-4' : 'flex flex-col gap-1'
          }
        >
          <div className="flex flex-wrap justify-between gap-2">
            <span className="type-label">{r.summary}</span>
            <span className="type-caption text-ink-muted">
              {r.closedAt
                ? `${formatDate(r.openedAt)}–${formatDate(r.closedAt)}`
                : `Open since ${formatDate(r.openedAt)}`}{' '}
              · {byLine(r.openedBy)}
            </span>
          </div>
          {r.notes && <span className="whitespace-pre-line">{r.notes}</span>}
        </div>
      ))}
    </Card>
  );
}

function describeEvent(e: AssetEvent): string {
  const status =
    e.fromStatus && e.toStatus
      ? `Status: ${assetStatusLabels[e.fromStatus]} → ${assetStatusLabels[e.toStatus]}`
      : '';
  switch (e.kind) {
    case 'edited':
      return `Edited: ${e.subject}`;
    case 'status_changed':
      return status;
    case 'assigned':
      return `Assigned to ${e.subject}`;
    case 'returned':
      return `Returned from ${e.subject}`;
    case 'repair_opened':
      return `Repair logged: ${e.subject}`;
    case 'repair_closed':
      return `Repair closed: ${e.subject}`;
  }
}

export function ActivityCard({ history }: { history: AssetHistory | undefined }) {
  return (
    <Card className="flex flex-col gap-3">
      <h2 className="m-0 type-heading">Activity</h2>
      {history && history.activity.length === 0 && (
        <p className="m-0 text-ink-muted">Nothing has happened to this asset yet.</p>
      )}
      <ol className="m-0 flex list-none flex-col gap-3 p-0">
        {history?.activity.map((e) => (
          <li key={e.id} className="flex flex-col">
            <span>{describeEvent(e)}</span>
            {e.kind !== 'status_changed' && e.fromStatus && e.toStatus && (
              <span className="type-caption text-ink-muted">
                {assetStatusLabels[e.fromStatus]} → {assetStatusLabels[e.toStatus]}
              </span>
            )}
            <span className="type-caption text-ink-muted">
              {formatDate(e.at)} · {byLine(e.by)}
            </span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

/** Whether the server will let this asset be deleted: nothing in its history but edits. */
export function canDelete(history: AssetHistory | undefined): boolean {
  return history !== undefined && history.activity.every((e) => e.kind === 'edited');
}
