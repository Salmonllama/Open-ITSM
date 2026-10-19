import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeApp } from './helpers/app.js';
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from './helpers/db.js';
import { createUser, issueToken, signIn, withToken } from './helpers/seed.js';

type Session = Awaited<ReturnType<typeof signIn>>;

describe.skipIf(!testDatabaseUrl)('statuses, assignment history and repairs', () => {
  let t: TestDatabase;
  let app: Awaited<ReturnType<typeof makeApp>>;
  let tech: Session;
  let typeId: string;

  async function newAsset(name = 'Laptop', status?: string): Promise<{ id: string }> {
    const res = await tech.request({
      method: 'POST',
      url: '/api/assets',
      payload: { typeId, name, ...(status ? { status } : {}) },
    });
    if (res.statusCode !== 201) throw new Error(`${res.statusCode} ${res.body}`);
    return res.json();
  }

  function post(session: Session, url: string, payload: object = {}) {
    return session.request({ method: 'POST', url, payload });
  }

  async function history(id: string) {
    const res = await tech.request({ method: 'GET', url: `/api/assets/${id}/history` });
    expect(res.statusCode).toBe(200);
    return res.json() as {
      assignments: {
        assignee: string;
        location: string;
        endedAt: string | null;
        startedBy: { name: string } | null;
      }[];
      repairs: { id: string; summary: string; notes: string; closedAt: string | null }[];
      activity: {
        kind: string;
        fromStatus: string | null;
        toStatus: string | null;
        subject: string;
      }[];
    };
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
      const res = await post(tech, '/api/asset-types', { name: 'Laptop', prefix: 'LAP' });
      typeId = res.json().id;
    }
  });

  describe('acceptance', () => {
    it('opening a repair moves the asset to in repair, and closing it restores the status', async () => {
      const asset = await newAsset();
      await post(tech, `/api/assets/${asset.id}/assign`, { assignee: 'Priya Nair' });

      const opened = await post(tech, `/api/assets/${asset.id}/repairs`, {
        summary: 'Battery replaced',
        notes: 'Swelling',
      });
      expect(opened.statusCode).toBe(200);
      expect(opened.json().status).toBe('in_repair');

      const [repair] = (await history(asset.id)).repairs;
      const closed = await post(tech, `/api/assets/${asset.id}/repairs/${repair?.id}/close`, {
        notes: 'Replaced in house',
      });
      expect(closed.statusCode).toBe(200);
      expect(closed.json().status).toBe('deployed');

      const after = await history(asset.id);
      expect(after.repairs).toMatchObject([
        { summary: 'Battery replaced', notes: 'Replaced in house' },
      ]);
      expect(after.repairs[0]?.closedAt).not.toBeNull();
      // The assignment stayed open through the repair.
      expect(after.assignments).toHaveLength(1);
      expect(after.assignments[0]?.endedAt).toBeNull();
    });

    it('a repair inserted straight into the database still sets the status', async () => {
      const asset = await newAsset();
      await t.pool.query(
        `insert into repairs (asset_id, summary, previous_status) values ($1, 'Screen', 'in_stock')`,
        [asset.id],
      );
      const res = await tech.request({ method: 'GET', url: `/api/assets/${asset.id}` });
      expect(res.json().status).toBe('in_repair');
    });

    it('history shows every assignment, newest first', async () => {
      const asset = await newAsset();
      await post(tech, `/api/assets/${asset.id}/assign`, {
        assignee: 'Daniel Ortiz',
        location: 'Remote',
      });
      const reassigned = await post(tech, `/api/assets/${asset.id}/assign`, {
        location: 'Cabinet A',
      });
      expect(reassigned.json().status).toBe('deployed');
      const returned = await post(tech, `/api/assets/${asset.id}/return`);
      expect(returned.json().status).toBe('in_stock');
      await post(tech, `/api/assets/${asset.id}/assign`, {
        assignee: 'Priya Nair',
        location: 'HQ, 3rd floor',
      });

      const { assignments, activity } = await history(asset.id);
      expect(assignments.map((a) => [a.assignee, a.location, a.endedAt === null])).toEqual([
        ['Priya Nair', 'HQ, 3rd floor', true],
        ['', 'Cabinet A', false],
        ['Daniel Ortiz', 'Remote', false],
      ]);
      expect(assignments[0]?.startedBy).toEqual({ kind: 'user', name: 'tech' });
      expect(activity.map((e) => [e.kind, e.toStatus, e.subject])).toEqual([
        ['assigned', 'deployed', 'Priya Nair, HQ, 3rd floor'],
        ['returned', 'in_stock', 'Cabinet A'],
        ['assigned', null, 'Cabinet A'],
        ['returned', null, 'Daniel Ortiz, Remote'],
        ['assigned', 'deployed', 'Daniel Ortiz, Remote'],
      ]);
    });
  });

  describe('status rules', () => {
    it('sets Deployed and In repair only through assignments and repairs', async () => {
      const bad = await post(tech, '/api/assets', { typeId, name: 'X', status: 'deployed' });
      expect(bad.statusCode).toBe(400);

      const asset = await newAsset();
      await post(tech, `/api/assets/${asset.id}/assign`, { assignee: 'Ann' });
      const locked = await tech.request({
        method: 'PATCH',
        url: `/api/assets/${asset.id}`,
        payload: { status: 'in_stock' },
      });
      expect(locked.statusCode).toBe(409);
      expect(locked.json().error).toBe('status_from_assignment');

      const byHand = await tech.request({
        method: 'PATCH',
        url: `/api/assets/${asset.id}`,
        payload: { status: 'deployed' },
      });
      expect(byHand.statusCode).toBe(400);
      // Other edits still work while deployed.
      const ok = await tech.request({
        method: 'PATCH',
        url: `/api/assets/${asset.id}`,
        payload: { name: 'Renamed' },
      });
      expect(ok.json()).toMatchObject({ name: 'Renamed', status: 'deployed' });
    });

    it('refuses to assign or repair a retired asset, and to assign during a repair', async () => {
      const retired = await newAsset('Old', 'retired');
      expect(
        (await post(tech, `/api/assets/${retired.id}/assign`, { assignee: 'Ann' })).json().error,
      ).toBe('asset_retired');
      expect(
        (await post(tech, `/api/assets/${retired.id}/repairs`, { summary: 'Fan' })).json().error,
      ).toBe('asset_retired');

      const asset = await newAsset();
      await post(tech, `/api/assets/${asset.id}/repairs`, { summary: 'Fan' });
      const assign = await post(tech, `/api/assets/${asset.id}/assign`, { assignee: 'Ann' });
      expect(assign.statusCode).toBe(409);
      expect(assign.json().error).toBe('asset_in_repair');
      expect(
        (await post(tech, `/api/assets/${asset.id}/repairs`, { summary: 'Again' })).json().error,
      ).toBe('repair_open');
      const patch = await tech.request({
        method: 'PATCH',
        url: `/api/assets/${asset.id}`,
        payload: { status: 'retired' },
      });
      expect(patch.json().error).toBe('asset_in_repair');
    });

    it('needs a person or a location, and an open assignment to return', async () => {
      const asset = await newAsset();
      const empty = await post(tech, `/api/assets/${asset.id}/assign`, { assignee: '  ' });
      expect(empty.statusCode).toBe(400);
      const notAssigned = await post(tech, `/api/assets/${asset.id}/return`);
      expect(notAssigned.json().error).toBe('not_assigned');
    });

    it('retires an asset on return and records status changes', async () => {
      const asset = await newAsset('Spare', 'preparing');
      await tech.request({
        method: 'PATCH',
        url: `/api/assets/${asset.id}`,
        payload: { status: 'in_stock' },
      });
      await post(tech, `/api/assets/${asset.id}/assign`, { assignee: 'Ann' });
      const res = await post(tech, `/api/assets/${asset.id}/return`, { status: 'retired' });
      expect(res.json().status).toBe('retired');
      const { activity } = await history(asset.id);
      expect(activity.map((e) => [e.kind, e.fromStatus, e.toStatus])).toEqual([
        ['returned', 'deployed', 'retired'],
        ['assigned', 'in_stock', 'deployed'],
        ['status_changed', 'preparing', 'in_stock'],
      ]);
    });

    it('closes a repair only once', async () => {
      const asset = await newAsset();
      await post(tech, `/api/assets/${asset.id}/repairs`, { summary: 'Hinge' });
      const [repair] = (await history(asset.id)).repairs;
      const url = `/api/assets/${asset.id}/repairs/${repair?.id}/close`;
      expect((await post(tech, url)).json().status).toBe('in_stock');
      expect((await post(tech, url)).json().error).toBe('repair_not_open');
    });
  });

  describe('append-only history', () => {
    it('lets the database end an assignment but never rewrite or delete history', async () => {
      const asset = await newAsset();
      await post(tech, `/api/assets/${asset.id}/assign`, { assignee: 'Ann' });
      await expect(
        t.pool.query(`update asset_assignments set assignee = 'Bob' where asset_id = $1`, [
          asset.id,
        ]),
      ).rejects.toThrow(/append only/);
      await expect(
        t.pool.query(`delete from asset_assignments where asset_id = $1`, [asset.id]),
      ).rejects.toThrow(/append only/);
      await expect(
        t.pool.query(`delete from asset_events where asset_id = $1`, [asset.id]),
      ).rejects.toThrow(/append only/);
      await expect(
        t.pool.query(`update asset_events set subject = 'x' where asset_id = $1`, [asset.id]),
      ).rejects.toThrow(/append only/);
      await expect(
        t.pool.query(
          `insert into asset_assignments (asset_id, assignee) values ($1, 'Second open')`,
          [asset.id],
        ),
      ).rejects.toThrow(/asset_assignments_one_open/);
    });

    it('deletes an asset with only edits, and refuses once it has other history', async () => {
      const edited = await newAsset('Typo');
      await tech.request({
        method: 'PATCH',
        url: `/api/assets/${edited.id}`,
        payload: { name: 'Fixed' },
      });
      expect((await history(edited.id)).activity).toMatchObject([
        { kind: 'edited', subject: 'Name' },
      ]);
      expect(
        (await tech.request({ method: 'DELETE', url: `/api/assets/${edited.id}` })).statusCode,
      ).toBe(204);

      const used = await newAsset();
      await post(tech, `/api/assets/${used.id}/assign`, { assignee: 'Ann' });
      await post(tech, `/api/assets/${used.id}/return`);
      const res = await tech.request({ method: 'DELETE', url: `/api/assets/${used.id}` });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('has_history');
    });
  });

  describe('tokens and suggestions', () => {
    it('needs assets:write to change history and names the service account', async () => {
      const admin = await signIn(app, 'root@example.com');
      const reader = await issueToken(admin, ['assets:read']);
      const writer = await issueToken(admin, ['assets:read', 'assets:write'], 'Intune sync');
      const asset = await newAsset();

      const refused = await withToken(app, reader.token, {
        method: 'POST',
        url: `/api/assets/${asset.id}/assign`,
        payload: { assignee: 'Ann' },
      });
      expect(refused.statusCode).toBe(403);
      const read = await withToken(app, reader.token, {
        method: 'GET',
        url: `/api/assets/${asset.id}/history`,
      });
      expect(read.statusCode).toBe(200);

      const assigned = await withToken(app, writer.token, {
        method: 'POST',
        url: `/api/assets/${asset.id}/assign`,
        payload: { assignee: 'Ann' },
      });
      expect(assigned.statusCode).toBe(200);
      expect(assigned.json().updatedBy).toEqual({ kind: 'service_account', name: 'Intune sync' });
      const { assignments } = await history(asset.id);
      expect(assignments[0]?.startedBy).toEqual({ kind: 'service_account', name: 'Intune sync' });
    });

    it('suggests people and locations from earlier assignments', async () => {
      const asset = await newAsset();
      await post(tech, `/api/assets/${asset.id}/assign`, {
        assignee: 'Zed Suggest',
        location: 'Zed room',
      });
      const res = await tech.request({
        method: 'GET',
        url: '/api/assets/assignment-suggestions?q=zed',
      });
      expect(res.json()).toEqual({ assignees: ['Zed Suggest'], locations: ['Zed room'] });
    });
  });
});
