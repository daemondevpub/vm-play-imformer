import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUpdateData, createSheetsClient } from '../src/sheets.js';

const serviceAccount = { client_email: 'a@b.iam.gserviceaccount.com', private_key: 'key' };
const authFactory = () => ({ getAccessToken: async () => 'access-token' });

test('builds one ranged update per changed row plus the heartbeat cell', () => {
  const data = buildUpdateData({
    sheetTab: 'Apps',
    rows: [
      {
        rowNumber: 5,
        appName: 'Vasu App',
        developer: 'VASU COMPANY LLC',
        status: 'live',
        firstLive: '2026-09-03 14:51',
        lastRemoved: '',
        lastChange: '2026-09-03 14:51',
        pendingFlip: '',
      },
    ],
    lastRunAt: '2026-09-03 14:51',
  });

  assert.deepEqual(data, [
    {
      range: "'Apps'!B5:H5",
      values: [['Vasu App', 'VASU COMPANY LLC', 'live', '2026-09-03 14:51', '', '2026-09-03 14:51', '']],
    },
    { range: "'Apps'!J2", values: [['2026-09-03 14:51']] },
  ]);
});

test('writes only the heartbeat when nothing changed', () => {
  const data = buildUpdateData({ sheetTab: 'Apps', rows: [], lastRunAt: '2026-09-03 14:51' });
  assert.equal(data.length, 1);
  assert.equal(data[0].range, "'Apps'!J2");
});

test('quotes a tab name containing a space', () => {
  const data = buildUpdateData({ sheetTab: 'My Apps', rows: [], lastRunAt: 'x' });
  assert.equal(data[0].range, "'My Apps'!J2");
});

test('readRows requests the A2:H range and returns its values', async () => {
  let requestedUrl = null;
  const fetchImpl = async (url, options) => {
    requestedUrl = url;
    assert.equal(options.headers.Authorization, 'Bearer access-token');
    return { ok: true, status: 200, json: async () => ({ values: [['com.vasu.app']] }) };
  };
  const client = createSheetsClient({
    serviceAccount,
    sheetId: 'sheet-123',
    sheetTab: 'Apps',
    fetchImpl,
    authFactory,
  });
  const values = await client.readRows();
  assert.deepEqual(values, [['com.vasu.app']]);
  assert.ok(requestedUrl.includes('/spreadsheets/sheet-123/values/'));
  assert.ok(decodeURIComponent(requestedUrl).includes("'Apps'!A2:H"));
});

test('readRows returns an empty array when the sheet has no data rows', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({}) });
  const client = createSheetsClient({
    serviceAccount,
    sheetId: 'sheet-123',
    sheetTab: 'Apps',
    fetchImpl,
    authFactory,
  });
  assert.deepEqual(await client.readRows(), []);
});

test('readRows throws a descriptive error on an API failure', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, text: async () => 'forbidden' });
  const client = createSheetsClient({
    serviceAccount,
    sheetId: 'sheet-123',
    sheetTab: 'Apps',
    fetchImpl,
    authFactory,
  });
  await assert.rejects(() => client.readRows(), /403/);
});

test('writeChanges posts a single batch update with RAW input', async () => {
  let body = null;
  const fetchImpl = async (url, options) => {
    if (url.includes(':batchUpdate')) {
      body = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => ({}) };
    }
    throw new Error(`unexpected url ${url}`);
  };
  const client = createSheetsClient({
    serviceAccount,
    sheetId: 'sheet-123',
    sheetTab: 'Apps',
    fetchImpl,
    authFactory,
  });
  await client.writeChanges({
    rows: [
      {
        rowNumber: 5,
        appName: 'A',
        developer: 'D',
        status: 'live',
        firstLive: '',
        lastRemoved: '',
        lastChange: '',
        pendingFlip: '',
      },
    ],
    lastRunAt: '2026-09-03 14:51',
  });
  assert.equal(body.valueInputOption, 'RAW');
  assert.equal(body.data.length, 2);
});

test('writeChanges throws a descriptive error on an API failure', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  const client = createSheetsClient({
    serviceAccount,
    sheetId: 'sheet-123',
    sheetTab: 'Apps',
    fetchImpl,
    authFactory,
  });
  await assert.rejects(() => client.writeChanges({ rows: [], lastRunAt: 'x' }), /500/);
});
