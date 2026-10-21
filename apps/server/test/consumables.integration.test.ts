import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeApp } from './helpers/app.js';
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from './helpers/db.js';
import { createUser, issueToken, signIn, withToken } from './helpers/seed.js';

type Session = Awaited<ReturnType<typeof signIn>>;
type Detail = {
  id: string;
  name: string;
  quantity: number;
  lowStockThreshold: number;
  low: boolean;
  deletable: boolean;
  adjustments: {
    kind: string;
    change: number;
    quantityAfter: number;
    reason: string;
    by: { kind: string; name: string } | null;
    repair: { id: string; summary: string; asset: { number: string } } | null;
  }[];
};

describe.skipIf(!testDatabaseUrl)('consumables', () => {
  let t: TestDatabase;
  let app: Awaited<ReturnType<typeof makeApp>>;
  let tech: Session;
  let typeId: string;
  let seq = 0;

  function post(session: Session, url: string, payload: object = {}) {
    return session.request({ method: 'POST', url, payload });
  }

  async function newConsumable(quantity = 0, lowStockThreshold = 0): Promise<Detail> {
    seq += 1;
    const res = await post(tech, '/api/consumables', {
      name: `Item ${seq}`,
      quantity,
      lowStockThreshold,
    });
    if (res.statusCode !== 201) throw new Error(`${res.statusCode} ${res.body}`);
    return res.json();
  }

  function adjust(id: string, payload: object, session = tech) {
    return post(session, `/api/consumables/${id}/adjustments`, payload);
  }

  async function openRepair(): Promise<{ assetId: string; repairId: string }> {
    const asset = await post(tech, '/api/assets', { typeId, name: 'Printer' });
    const assetId = asset.json().id as string;
    await post(tech, `/api/assets/${assetId}/repairs`, { summary: 'Toner smears' });
    const history = await tech.request({ method: 'GET', url: `/api/assets/${assetId}/history` });
    return { assetId, repairId: history.json().repairs[0].id };
  }

  beforeAll(async () => {
    t = await createTestDatabase();
    await createUser(t.db, 'root@example.com', 'admin');
    await createUser(t.db, 'tech@example.com', 'technician');
  });
  afterAll(async () => {
    await app?.close();
    await t?.drop();
  });
  beforeEach(async () => {
    await app?.close();
    app = await makeApp({ db: t.db });
    tech = await signIn(app, 'tech@example.com');
    if (!typeId) {
      const res = await post(tech, '/api/asset-types', { name: 'Printer', prefix: 'PRN' });
      typeId = res.json().id;
    }
  });

  describe('acceptance', () => {
    it('stock cannot go below zero through the API', async () => {
      const item = await newConsumable(3);
      const refused = await adjust(item.id, { kind: 'use', amount: 4 });
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ error: 'not_enough_stock' });
      expect(refused.json().message).toContain('Only 3 left');

      const used = await adjust(item.id, { kind: 'use', amount: 3 });
      expect(used.statusCode).toBe(200);
      expect(used.json().quantity).toBe(0);
      const none = await adjust(item.id, { kind: 'use', amount: 1 });
      expect(none.statusCode).toBe(409);
      expect(none.json().message).toContain('None left');
      const negative = await adjust(item.id, { kind: 'count', quantity: -1, reason: 'Oops' });
      expect(negative.statusCode).toBe(400);
    });

    it('stock cannot go below zero in the database, whoever writes it', async () => {
      const item = await newConsumable(2);
      await expect(
        t.pool.query(
          `insert into consumable_adjustments (consumable_id, kind, change, quantity_after) values ($1, 'used', -3, 0)`,
          [item.id],
        ),
      ).rejects.toThrow(/consumables_quantity_not_negative/);
      await expect(
        t.pool.query(`update consumables set quantity = 10 where id = $1`, [item.id]),
      ).rejects.toThrow(/only through consumable_adjustments/);
      await expect(
        t.pool.query(`insert into consumables (name, quantity) values ('Sneaky', 5)`),
      ).rejects.toThrow(/only through consumable_adjustments/);
      const { rows } = await t.pool.query('select quantity from consumables where id = $1', [
        item.id,
      ]);
      expect(rows[0].quantity).toBe(2);
    });

    it('two uses at once cannot both take the last unit', async () => {
      const item = await newConsumable(1);
      const results = await Promise.all([
        adjust(item.id, { kind: 'use', amount: 1 }),
        adjust(item.id, { kind: 'use', amount: 1 }),
      ]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    });

    it('low-stock items are flagged for the dashboard', async () => {
      const toner = await post(tech, '/api/consumables', {
        name: 'HP 89A toner',
        quantity: 5,
        lowStockThreshold: 2,
      });
      const id = toner.json().id as string;
      expect(toner.json().low).toBe(false);

      await adjust(id, { kind: 'use', amount: 3 });
      const summary = await tech.request({ method: 'GET', url: '/api/consumables/low-stock' });
      expect(summary.statusCode).toBe(200);
      expect(summary.json().items).toContainEqual({ id, name: 'HP 89A toner', quantity: 2 });

      const list = await tech.request({ method: 'GET', url: '/api/consumables?low=true' });
      expect(list.json().items.map((i: { id: string }) => i.id)).toContain(id);
      expect(list.json().items.every((i: { low: boolean }) => i.low)).toBe(true);
      expect(list.json().lowCount).toBe(list.json().total);

      await adjust(id, { kind: 'add', amount: 10, reason: 'Order 4411' });
      const after = await tech.request({ method: 'GET', url: '/api/consumables/low-stock' });
      expect(after.json().items.map((i: { id: string }) => i.id)).not.toContain(id);
    });

    it('a threshold of 0 never flags an item, even at zero stock', async () => {
      const item = await newConsumable(0, 0);
      expect(item.low).toBe(false);
      const summary = await tech.request({ method: 'GET', url: '/api/consumables/low-stock' });
      expect(summary.json().items.map((i: { id: string }) => i.id)).not.toContain(item.id);
    });
  });

  it('records every change with who made it, newest first', async () => {
    const item = await newConsumable(4);
    await adjust(item.id, { kind: 'add', amount: 6, reason: 'Delivery' });
    await adjust(item.id, { kind: 'use', amount: 2 });
    const counted = await adjust(item.id, { kind: 'count', quantity: 7, reason: 'Stocktake' });
    expect(counted.statusCode).toBe(200);
    const detail = counted.json() as Detail;
    expect(detail.quantity).toBe(7);
    expect(detail.deletable).toBe(false);
    expect(
      detail.adjustments.map(({ kind, change, quantityAfter, reason }) => ({
        kind,
        change,
        quantityAfter,
        reason,
      })),
    ).toEqual([
      { kind: 'counted', change: -1, quantityAfter: 7, reason: 'Stocktake' },
      { kind: 'used', change: -2, quantityAfter: 8, reason: '' },
      { kind: 'added', change: 6, quantityAfter: 10, reason: 'Delivery' },
      { kind: 'created', change: 4, quantityAfter: 4, reason: '' },
    ]);
    expect(detail.adjustments[0]?.by).toMatchObject({ kind: 'user' });
  });

  it('a count needs a reason', async () => {
    const item = await newConsumable(1);
    const res = await adjust(item.id, { kind: 'count', quantity: 3, reason: '  ' });
    expect(res.statusCode).toBe(400);
  });

  it('uses can be linked to an open repair and show on the repair', async () => {
    const item = await post(tech, '/api/consumables', { name: 'Fuser kit', quantity: 3 });
    const { assetId, repairId } = await openRepair();

    const open = await tech.request({ method: 'GET', url: '/api/repairs/open?q=PRN' });
    expect(open.json().map((r: { id: string }) => r.id)).toContain(repairId);

    const used = await adjust(item.json().id, { kind: 'use', amount: 1, repairId });
    expect(used.statusCode).toBe(200);
    await adjust(item.json().id, { kind: 'use', amount: 1, repairId });
    expect(used.json().adjustments[0].repair).toMatchObject({
      id: repairId,
      summary: 'Toner smears',
    });

    const history = await tech.request({ method: 'GET', url: `/api/assets/${assetId}/history` });
    expect(history.json().repairs[0].parts).toEqual([
      { consumableId: item.json().id, name: 'Fuser kit', quantity: 2 },
    ]);

    // A closed repair cannot take more parts, and the stock is untouched.
    await post(tech, `/api/assets/${assetId}/repairs/${repairId}/close`);
    const late = await adjust(item.json().id, { kind: 'use', amount: 1, repairId });
    expect(late.statusCode).toBe(409);
    expect(late.json().error).toBe('repair_not_open');
    const detail = await tech.request({ method: 'GET', url: `/api/consumables/${item.json().id}` });
    expect(detail.json().quantity).toBe(1);
  });

  it('names are unique ignoring case', async () => {
    const first = await post(tech, '/api/consumables', { name: 'AA batteries' });
    expect(first.statusCode).toBe(201);
    const again = await post(tech, '/api/consumables', { name: 'aa Batteries' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('name_taken');
  });

  it('edits change the name and threshold but never the quantity', async () => {
    const item = await newConsumable(5, 1);
    const res = await tech.request({
      method: 'PATCH',
      url: `/api/consumables/${item.id}`,
      payload: { name: 'USB-C chargers, 65 W', lowStockThreshold: 6, quantity: 100 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      name: 'USB-C chargers, 65 W',
      lowStockThreshold: 6,
      quantity: 5,
      low: true,
    });
  });

  it('can be deleted only until its stock has changed', async () => {
    const fresh = await newConsumable(3);
    const deleted = await tech.request({ method: 'DELETE', url: `/api/consumables/${fresh.id}` });
    expect(deleted.statusCode).toBe(204);
    const { rows } = await t.pool.query(
      `select details from audit_log where action = 'consumable.deleted'`,
    );
    expect(rows[0].details).toMatchObject({ consumableId: fresh.id, quantity: 3 });

    const used = await newConsumable(3);
    await adjust(used.id, { kind: 'use', amount: 1 });
    const refused = await tech.request({ method: 'DELETE', url: `/api/consumables/${used.id}` });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('has_history');
  });

  it('history is append only', async () => {
    const item = await newConsumable(1);
    await expect(
      t.pool.query(`update consumable_adjustments set reason = 'x' where consumable_id = $1`, [
        item.id,
      ]),
    ).rejects.toThrow(/append only/);
    await expect(
      t.pool.query(`delete from consumable_adjustments where consumable_id = $1`, [item.id]),
    ).rejects.toThrow(/append only/);
    await expect(t.pool.query('truncate consumable_adjustments')).rejects.toThrow(/append only/);
  });

  it('tokens need the asset scopes and changes name the service account', async () => {
    const admin = await signIn(app, 'root@example.com');
    const reader = await issueToken(admin, ['assets:read']);
    const writer = await issueToken(admin, ['assets:read', 'assets:write'], 'Stock script');
    const item = await newConsumable(5);

    const read = await withToken(app, reader.token, { method: 'GET', url: '/api/consumables' });
    expect(read.statusCode).toBe(200);
    const refused = await withToken(app, reader.token, {
      method: 'POST',
      url: `/api/consumables/${item.id}/adjustments`,
      payload: { kind: 'use', amount: 1 },
    });
    expect(refused.statusCode).toBe(403);

    const used = await withToken(app, writer.token, {
      method: 'POST',
      url: `/api/consumables/${item.id}/adjustments`,
      payload: { kind: 'use', amount: 1, reason: 'Nightly sync' },
    });
    expect(used.statusCode).toBe(200);
    expect(used.json().adjustments[0].by).toEqual({
      kind: 'service_account',
      name: 'Stock script',
    });
  });
});
