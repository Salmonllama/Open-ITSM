import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeApp } from './helpers/app.js';
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from './helpers/db.js';
import { createUser, issueToken, signIn, withToken } from './helpers/seed.js';

type Session = Awaited<ReturnType<typeof signIn>>;

describe.skipIf(!testDatabaseUrl)('asset types, assets and CSV import', () => {
  let t: TestDatabase;
  let app: Awaited<ReturnType<typeof makeApp>>;
  let tech: Session;

  async function createType(
    session: Session,
    name: string,
    prefix: string,
    fields: object[] = [],
  ): Promise<{ id: string; fields: { id: string; key: string }[] }> {
    const res = await session.request({
      method: 'POST',
      url: '/api/asset-types',
      payload: { name, prefix, fields },
    });
    if (res.statusCode !== 201) throw new Error(`${res.statusCode} ${res.body}`);
    return res.json();
  }

  function createAsset(session: Session, payload: object) {
    return session.request({ method: 'POST', url: '/api/assets', payload });
  }

  function importCsv(session: Session, typeId: string, csv: string, dryRun = false) {
    return session.request({
      method: 'POST',
      url: `/api/assets/import?typeId=${typeId}&dryRun=${dryRun}`,
      payload: csv,
      headers: { 'content-type': 'text/csv' },
    });
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
  });

  describe('asset types and custom fields', () => {
    it('lets a technician define a type with fields and keys them by label', async () => {
      const type = await createType(tech, 'Laptop', 'lap', [
        { label: 'Serial number', kind: 'text', required: true },
        { label: 'Make', kind: 'select', options: ['Dell', 'Lenovo'] },
        { label: 'Purchased', kind: 'date' },
      ]);
      expect(type).toMatchObject({ name: 'Laptop', prefix: 'LAP', nextNumber: 1, assetCount: 0 });
      expect(type.fields.map((f) => f.key)).toEqual(['serial_number', 'make', 'purchased']);
    });

    it('rejects a duplicate name or prefix', async () => {
      await createType(tech, 'Monitor', 'MON');
      const byName = await tech.request({
        method: 'POST',
        url: '/api/asset-types',
        payload: { name: 'monitor', prefix: 'MN' },
      });
      expect(byName.json().error).toBe('name_taken');
      const byPrefix = await tech.request({
        method: 'POST',
        url: '/api/asset-types',
        payload: { name: 'Display', prefix: 'MON' },
      });
      expect(byPrefix.json().error).toBe('prefix_taken');
    });

    it('refuses a select without options and keeps a field kind fixed', async () => {
      const type = await createType(tech, 'Phone', 'PHN');
      const noOptions = await tech.request({
        method: 'POST',
        url: `/api/asset-types/${type.id}/fields`,
        payload: { label: 'Carrier', kind: 'select' },
      });
      expect(noOptions.statusCode).toBe(400);
      const field = await tech.request({
        method: 'POST',
        url: `/api/asset-types/${type.id}/fields`,
        payload: { label: 'IMEI', kind: 'text' },
      });
      expect(field.statusCode).toBe(201);
      const change = await tech.request({
        method: 'PATCH',
        url: `/api/asset-types/${type.id}/fields/${field.json().id}`,
        payload: { kind: 'number' },
      });
      expect(change.statusCode).toBe(400);
    });

    it('will not remove a select option that assets use', async () => {
      const type = await createType(tech, 'Dock', 'DCK', [
        { label: 'Make', kind: 'select', options: ['Dell', 'HP'] },
      ]);
      const make = type.fields[0];
      if (!make) throw new Error('no field');
      expect(
        (await createAsset(tech, { typeId: type.id, name: 'Dock 1', fields: { make: 'HP' } }))
          .statusCode,
      ).toBe(201);
      const res = await tech.request({
        method: 'PATCH',
        url: `/api/asset-types/${type.id}/fields/${make.id}`,
        payload: { options: ['Dell'] },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('option_in_use');
      const ok = await tech.request({
        method: 'PATCH',
        url: `/api/asset-types/${type.id}/fields/${make.id}`,
        payload: { options: ['HP', 'Dell', 'Lenovo'] },
      });
      expect(ok.statusCode).toBe(200);
    });

    it('strips a deleted field from assets and deletes only unused types', async () => {
      const type = await createType(tech, 'Tablet', 'TAB', [{ label: 'Colour', kind: 'text' }]);
      const asset = await createAsset(tech, {
        typeId: type.id,
        name: 'Tablet 1',
        fields: { colour: 'Grey' },
      });
      const colour = type.fields[0];
      if (!colour) throw new Error('no field');
      expect(
        (
          await tech.request({
            method: 'DELETE',
            url: `/api/asset-types/${type.id}/fields/${colour.id}`,
          })
        ).statusCode,
      ).toBe(204);
      const after = await tech.request({ method: 'GET', url: `/api/assets/${asset.json().id}` });
      expect(after.json().fields).toEqual({});

      const inUse = await tech.request({ method: 'DELETE', url: `/api/asset-types/${type.id}` });
      expect(inUse.statusCode).toBe(409);
      const empty = await createType(tech, 'Empty', 'EMP');
      expect(
        (await tech.request({ method: 'DELETE', url: `/api/asset-types/${empty.id}` })).statusCode,
      ).toBe(204);
    });
  });

  describe('assets', () => {
    it('takes the next number per type, skipping numbers set by hand', async () => {
      const type = await createType(tech, 'Desktop', 'DSK');
      const manual = await createAsset(tech, {
        typeId: type.id,
        number: 'DSK-000002',
        name: 'Set by hand',
      });
      expect(manual.statusCode).toBe(201);
      const numbers = [];
      for (const name of ['One', 'Two']) {
        const res = await createAsset(tech, { typeId: type.id, name });
        expect(res.statusCode).toBe(201);
        numbers.push(res.json().number);
      }
      expect(numbers).toEqual(['DSK-000001', 'DSK-000003']);
      const created = await tech.request({ method: 'GET', url: `/api/asset-types/${type.id}` });
      expect(created.json().nextNumber).toBe(4);
    });

    it('rejects a number already used by any asset, ignoring case', async () => {
      const a = await createType(tech, 'Router', 'RTR');
      const b = await createType(tech, 'Switch', 'SW');
      expect(
        (await createAsset(tech, { typeId: a.id, number: 'NET-1', name: 'Router' })).statusCode,
      ).toBe(201);
      const dup = await createAsset(tech, { typeId: b.id, number: 'net-1', name: 'Switch' });
      expect(dup.statusCode).toBe(409);
      expect(dup.json().error).toBe('number_taken');
      expect(dup.json().message).toContain('net-1');
    });

    it('validates custom field values against the type', async () => {
      const type = await createType(tech, 'Printer', 'PRN', [
        { label: 'Serial', kind: 'text', required: true },
        { label: 'Pages', kind: 'number' },
        { label: 'Colour', kind: 'boolean' },
      ]);
      const missing = await createAsset(tech, { typeId: type.id, name: 'P1', fields: {} });
      expect(missing.statusCode).toBe(400);
      expect(missing.json().message).toContain('Serial is required');
      const wrong = await createAsset(tech, {
        typeId: type.id,
        name: 'P1',
        fields: { serial: 'X1', pages: 'many', other: 1 },
      });
      expect(wrong.statusCode).toBe(400);
      expect(wrong.json().message).toContain('Pages Enter a number');
      expect(wrong.json().message).toContain('is not a field of this asset type');
      const ok = await createAsset(tech, {
        typeId: type.id,
        name: 'P1',
        fields: { serial: ' X1 ', pages: 12, colour: true },
      });
      expect(ok.statusCode).toBe(201);
      expect(ok.json()).toMatchObject({
        status: 'in_stock',
        fields: { serial: 'X1', pages: 12, colour: true },
        updatedBy: { kind: 'user', name: 'tech' },
      });
    });

    it('updates name, status and fields, and finds an asset by number', async () => {
      const type = await createType(tech, 'Scanner', 'SCN', [{ label: 'Room', kind: 'text' }]);
      const asset = (await createAsset(tech, { typeId: type.id, name: 'Old' })).json();
      const res = await tech.request({
        method: 'PATCH',
        url: `/api/assets/${asset.id}`,
        payload: { name: 'New', status: 'retired', fields: { room: '2.01' } },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        name: 'New',
        status: 'retired',
        fields: { room: '2.01' },
      });
      const found = await tech.request({
        method: 'GET',
        url: `/api/assets/by-number/${asset.number.toLowerCase()}`,
      });
      expect(found.json().id).toBe(asset.id);

      const slashed = (
        await createAsset(tech, { typeId: type.id, number: 'OLD/42', name: 'Legacy label' })
      ).json();
      const bySlash = await tech.request({
        method: 'GET',
        url: `/api/assets/by-number/${encodeURIComponent('old/42')}`,
      });
      expect(bySlash.json().id).toBe(slashed.id);
    });

    it('searches number, name and field values, filters, counts and pages', async () => {
      const type = await createType(tech, 'Camera', 'CAM', [{ label: 'Serial', kind: 'text' }]);
      for (const [name, status, serial] of [
        ['Lobby camera', 'preparing', 'ZX-100'],
        ['Car park camera', 'preparing', 'ZX-200'],
        ['Spare camera', 'in_stock', 'QQ-999'],
      ] as const) {
        await createAsset(tech, { typeId: type.id, name, status, fields: { serial } });
      }
      const bySerial = await tech.request({ method: 'GET', url: '/api/assets?q=zx-' });
      expect(bySerial.json().items.map((a: { name: string }) => a.name)).toEqual([
        'Lobby camera',
        'Car park camera',
      ]);
      const preparing = await tech.request({
        method: 'GET',
        url: `/api/assets?typeId=${type.id}&status=preparing&pageSize=1&page=2`,
      });
      const body = preparing.json();
      expect(body.total).toBe(2);
      expect(body.items).toHaveLength(1);
      expect(body.counts).toMatchObject({ all: 3, preparing: 2, in_stock: 1, retired: 0 });
      const literal = await tech.request({ method: 'GET', url: '/api/assets?q=100%25' });
      expect(literal.json().total).toBe(0);
    });

    it('deletes an asset with an audit record', async () => {
      const type = await createType(tech, 'Projector', 'PRJ');
      const asset = (await createAsset(tech, { typeId: type.id, name: 'Mistake' })).json();
      expect(
        (await tech.request({ method: 'DELETE', url: `/api/assets/${asset.id}` })).statusCode,
      ).toBe(204);
      expect(
        (await tech.request({ method: 'GET', url: `/api/assets/${asset.id}` })).statusCode,
      ).toBe(404);
      const { rows } = await t.pool.query(
        `select details from audit_log where action = 'asset.deleted'`,
      );
      expect(rows.at(-1)?.details).toMatchObject({ assetId: asset.id, number: asset.number });
    });

    it('records a service account as the updater for token changes', async () => {
      const admin = await signIn(app, 'root@example.com');
      const { token } = await issueToken(admin, ['assets:write', 'assets:read'], 'Sync bot');
      const type = await createType(tech, 'Badge', 'BDG');
      const res = await withToken(app, token, {
        method: 'POST',
        url: '/api/assets',
        payload: { typeId: type.id, name: 'Badge 1' },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().updatedBy).toEqual({ kind: 'service_account', name: 'Sync bot' });
    });
  });

  describe('CSV import', () => {
    it('imports every row in one go, generating numbers and mapping columns by label', async () => {
      const type = await createType(tech, 'Headset', 'HDS', [
        { label: 'Make', kind: 'select', options: ['Jabra', 'Poly'] },
        { label: 'Wireless', kind: 'boolean' },
        { label: 'Price', kind: 'number' },
      ]);
      const csv = [
        '﻿Number,Name,Status,Make,Wireless,Price',
        ',Headset A,Preparing,jabra,yes,"1,200"',
        'HDS-000001,"Headset, B",,Poly,no,',
        ',"Headset\nC",retired,,,',
      ].join('\r\n');
      const dry = await importCsv(tech, type.id, csv, true);
      expect(dry.statusCode).toBe(200);
      expect(dry.json()).toMatchObject({ dryRun: true, rows: 3, created: 0, problems: [] });
      expect(
        (await tech.request({ method: 'GET', url: `/api/assets?typeId=${type.id}` })).json().total,
      ).toBe(0);

      const res = await importCsv(tech, type.id, csv);
      expect(res.json()).toMatchObject({ dryRun: false, rows: 3, created: 3 });
      const list = (
        await tech.request({ method: 'GET', url: `/api/assets?typeId=${type.id}` })
      ).json();
      expect(
        list.items.map((a: { number: string; name: string; status: string }) => [
          a.number,
          a.name,
          a.status,
        ]),
      ).toEqual([
        ['HDS-000001', 'Headset, B', 'in_stock'],
        ['HDS-000002', 'Headset A', 'preparing'],
        ['HDS-000003', 'Headset\nC', 'retired'],
      ]);
      const a = await tech.request({ method: 'GET', url: '/api/assets/by-number/HDS-000002' });
      expect(a.json().fields).toEqual({ make: 'Jabra', wireless: true, price: 1200 });
    });

    it('reports every problem with its line and creates nothing', async () => {
      const type = await createType(tech, 'Keyboard', 'KBD', [
        { label: 'Layout', kind: 'select', options: ['UK', 'US'], required: true },
      ]);
      await createAsset(tech, {
        typeId: type.id,
        number: 'KBD-7',
        name: 'Existing',
        fields: { layout: 'UK' },
      });
      const csv = [
        'Number,Name,Status,Layout',
        'KBD-1,One,,UK',
        'KBD-1,Two,,US',
        'kbd-7,Three,,UK',
        ',Four,Lost,FR',
        ',,,',
        ',,,UK',
      ].join('\n');
      const res = await importCsv(tech, type.id, csv);
      expect(res.statusCode).toBe(422);
      const problems = res.json().problems as { line: number; column: string; message: string }[];
      expect(problems.map((p) => [p.line, p.column])).toEqual([
        [3, 'Number'],
        [4, 'Number'],
        [5, 'Status'],
        [5, 'Layout'],
        [7, 'Name'],
      ]);
      expect(problems[0]?.message).toContain('also on line 2');
      expect(problems[1]?.message).toContain('existing Keyboard asset');
      expect(
        (await tech.request({ method: 'GET', url: `/api/assets?typeId=${type.id}` })).json().total,
      ).toBe(1);
    });

    it('reports header problems before reading rows', async () => {
      const type = await createType(tech, 'Mouse', 'MSE', [
        { label: 'DPI', kind: 'number', required: true },
      ]);
      const res = await importCsv(tech, type.id, 'Number,Colour,Number\n1,red,2\n');
      expect(res.statusCode).toBe(422);
      expect(res.json().problems.map((p: { column: string }) => p.column)).toEqual([
        'Colour',
        'Number',
        'Name',
        'DPI',
      ]);
    });

    it('needs the write scope for a token', async () => {
      const admin = await signIn(app, 'root@example.com');
      const { token } = await issueToken(admin, ['assets:read']);
      const type = await createType(tech, 'Webcam', 'WEB');
      const res = await withToken(app, token, {
        method: 'POST',
        url: `/api/assets/import?typeId=${type.id}`,
        payload: 'Name\nCam 1\n',
        headers: { 'content-type': 'text/csv' },
      });
      expect(res.statusCode).toBe(403);
    });
  });
});
