import {
  consumableDetailSchema,
  CONSUMABLE_QUANTITY_MAX,
  type Consumable,
  type ConsumableDetail,
  type RepairRef,
} from '@open-itsm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId } from 'react';
import { apiRequest } from '@/lib/api';
import { consumableQuery, consumablesQuery, openRepairsQuery } from '@/lib/queries';
import { FormDialog } from './form-dialog';
import { FormField } from './form-field';
import { Label, Select } from './ui/input';

function text(form: FormData, name: string): string {
  return String(form.get(name) ?? '').trim();
}

function whole(form: FormData, name: string): number {
  return Number(text(form, name));
}

/** Stores a saved consumable and refreshes the lists and low-stock counts that show it. */
function useSaved() {
  const queryClient = useQueryClient();
  return async (saved: ConsumableDetail, repair?: RepairRef) => {
    queryClient.setQueryData(consumableQuery(saved.id).queryKey, saved);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['consumables', 'list'] }),
      queryClient.invalidateQueries({ queryKey: ['consumables', 'low-stock'] }),
      repair && queryClient.invalidateQueries({ queryKey: ['assets', repair.asset.id, 'history'] }),
    ]);
  };
}

const quantityProps = { type: 'number', min: 0, max: CONSUMABLE_QUANTITY_MAX, step: 1 } as const;

/** Adds a consumable, or renames one and changes its threshold. */
export function ConsumableFormDialog({
  open,
  consumable,
  onClose,
  onSaved,
}: {
  open: boolean;
  consumable?: ConsumableDetail;
  onClose: () => void;
  onSaved?: (saved: ConsumableDetail) => void;
}) {
  const saved = useSaved();
  const save = useMutation({
    mutationFn: (body: object) =>
      consumable
        ? apiRequest('PATCH', `/api/consumables/${consumable.id}`, {
            body,
            schema: consumableDetailSchema,
          })
        : apiRequest('POST', '/api/consumables', { body, schema: consumableDetailSchema }),
    onSuccess: async (result) => {
      await saved(result);
      onClose();
      onSaved?.(result);
    },
  });

  return (
    <FormDialog
      open={open}
      title={consumable ? `Edit ${consumable.name}` : 'New consumable'}
      submitLabel={consumable ? 'Save changes' : 'Add consumable'}
      pending={save.isPending}
      error={save.error}
      onCancel={() => {
        save.reset();
        onClose();
      }}
      onSubmit={(form) =>
        save.mutate({
          name: text(form, 'name'),
          lowStockThreshold: whole(form, 'lowStockThreshold'),
          ...(consumable ? {} : { quantity: whole(form, 'quantity') }),
        })
      }
    >
      <FormField
        label="Name"
        name="name"
        required
        autoComplete="off"
        maxLength={200}
        defaultValue={consumable?.name}
        hint="What it is, like HP 89A toner or USB-C chargers, 65 W."
      />
      {!consumable && (
        <FormField
          label="In stock"
          name="quantity"
          required
          defaultValue={0}
          hint="How many you have now."
          {...quantityProps}
        />
      )}
      <FormField
        label="Low-stock threshold"
        name="lowStockThreshold"
        required
        defaultValue={consumable?.lowStockThreshold ?? 0}
        hint="Flag it as low when this many or fewer are left. Use 0 to never flag it."
        {...quantityProps}
      />
      {consumable && (
        <p className="m-0 type-caption text-ink-muted">
          Change the stock with Add stock, Use or Count, so its history stays complete.
        </p>
      )}
    </FormDialog>
  );
}

export type StockAction = 'add' | 'use' | 'count';

/**
 * Add stock, use stock or record a count. Opened from a consumable's page, it can link a use to
 * an open repair; opened from a repair, it asks which consumable was used.
 */
export function StockDialog({
  action,
  consumable,
  repair,
  onClose,
}: {
  action: StockAction | null;
  consumable?: Consumable;
  repair?: RepairRef;
  onClose: () => void;
}) {
  const consumableId = useId();
  const repairId = useId();
  const saved = useSaved();
  const choosingItem = consumable === undefined;
  const items = useQuery({
    ...consumablesQuery({ pageSize: 100 }),
    enabled: action !== null && choosingItem,
  });
  const repairs = useQuery({
    ...openRepairsQuery,
    enabled: action === 'use' && repair === undefined,
  });

  const adjust = useMutation({
    mutationFn: ({ id, body }: { id: string; body: object; repair?: RepairRef }) =>
      apiRequest('POST', `/api/consumables/${id}/adjustments`, {
        body,
        schema: consumableDetailSchema,
      }),
    onSuccess: async (result, { repair: linked }) => {
      await saved(result, linked);
      onClose();
    },
  });

  const name = consumable?.name ?? '';
  const title =
    action === 'add'
      ? `Add stock: ${name}`
      : action === 'count'
        ? `Count ${name}`
        : repair
          ? `Use parts for ${repair.asset.number}`
          : `Use ${name}`;

  return (
    <FormDialog
      open={action !== null}
      title={title}
      submitLabel={action === 'add' ? 'Add stock' : action === 'count' ? 'Save count' : 'Use'}
      pending={adjust.isPending}
      error={adjust.error}
      onCancel={() => {
        adjust.reset();
        onClose();
      }}
      onSubmit={(form) => {
        const id = consumable?.id ?? text(form, 'consumableId');
        const reason = text(form, 'reason');
        if (action === 'count') {
          adjust.mutate({ id, body: { kind: 'count', quantity: whole(form, 'quantity'), reason } });
          return;
        }
        const chosen = repair ?? repairs.data?.find((r) => r.id === text(form, 'repairId'));
        adjust.mutate({
          id,
          repair: chosen,
          body: {
            kind: action,
            amount: whole(form, 'amount'),
            reason,
            ...(action === 'use' && chosen ? { repairId: chosen.id } : {}),
          },
        });
      }}
    >
      {action === 'use' && repair && (
        <p className="m-0 type-body text-ink-muted">
          For the repair {repair.summary} on {repair.asset.name}.
        </p>
      )}
      {choosingItem && (
        <div className="flex flex-col gap-2">
          <Label htmlFor={consumableId}>Consumable</Label>
          <Select id={consumableId} name="consumableId" required defaultValue="">
            <option value="" disabled>
              {items.isPending ? 'Loading…' : 'Choose a consumable'}
            </option>
            {items.data?.items.map((c) => (
              <option key={c.id} value={c.id} disabled={c.quantity === 0}>
                {c.name} ({c.quantity === 0 ? 'none' : c.quantity} in stock)
              </option>
            ))}
          </Select>
          {items.data && items.data.items.length === 0 && (
            <p className="m-0 type-caption text-ink-muted">
              No consumables yet. Add them on the Consumables page first.
            </p>
          )}
        </div>
      )}
      {consumable && (
        <p className="m-0 type-body text-ink-muted">
          {consumable.quantity === 0 ? 'None' : consumable.quantity} in stock now.
          {action === 'count' && ' Enter the real count; the difference is recorded.'}
        </p>
      )}
      {action === 'count' ? (
        <FormField
          label="Count"
          name="quantity"
          required
          defaultValue={consumable?.quantity}
          {...quantityProps}
        />
      ) : (
        <FormField
          label={action === 'add' ? 'Amount added' : 'Amount used'}
          name="amount"
          required
          defaultValue={1}
          {...quantityProps}
          min={1}
          max={action === 'use' && consumable ? consumable.quantity : CONSUMABLE_QUANTITY_MAX}
        />
      )}
      {action === 'use' && !repair && (
        <div className="flex flex-col gap-2">
          <Label htmlFor={repairId}>Repair (optional)</Label>
          <Select id={repairId} name="repairId" defaultValue="">
            <option value="">Not for a repair</option>
            {repairs.data?.map((r) => (
              <option key={r.id} value={r.id}>
                {r.asset.number} · {r.summary}
              </option>
            ))}
          </Select>
          <p className="m-0 type-caption text-ink-muted">
            Choose an open repair to list these parts on it.
          </p>
        </div>
      )}
      <FormField
        label={action === 'count' ? 'Reason' : 'Reason (optional)'}
        name="reason"
        required={action === 'count'}
        autoComplete="off"
        maxLength={500}
        hint={
          action === 'add'
            ? 'Like Order 4411 or Delivery from Dell.'
            : action === 'count'
              ? 'Why the count changed, like Stocktake.'
              : 'Like Desk 3 printer.'
        }
      />
    </FormDialog>
  );
}
