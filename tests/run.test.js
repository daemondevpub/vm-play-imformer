import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runOnce } from '../src/run.js';
import { createLogger } from '../src/logger.js';

const CANARY = 'com.canary.doesnotexist.monitor';

function baseConfig(overrides = {}) {
  return {
    sheetTab: 'Apps',
    playRegion: 'US',
    concurrency: 5,
    recipients: ['919876543210', '919812345678'],
    templateAdded: 'play_store_app_added',
    templateRemoved: 'play_store_app_removed',
    canaryPackage: CANARY,
    dryRun: false,
    ...overrides,
  };
}

function stubs({ values, statuses, details = {}, sendResult = { ok: true, error: null } }) {
  const written = [];
  const sent = [];
  return {
    written,
    sent,
    sheets: {
      readRows: async () => values,
      writeChanges: async (payload) => written.push(payload),
    },
    whatsapp: {
      sendTemplate: async (message) => {
        sent.push(message);
        return sendResult;
      },
    },
    playstore: {
      checkAll: async (packages) => new Map(packages.map((p) => [p, statuses[p] ?? null])),
      fetchDetails: async (p) => details[p] ?? null,
    },
    logger: createLogger({ verbose: false, sink: () => {} }),
  };
}

const now = new Date('2026-09-03T09:21:00Z');

test('a first sighting of a disappearance only marks the row and sends nothing', async () => {
  const s = stubs({
    values: [['com.vasu.app', 'Vasu App Name', 'VASU COMPANY LLC', 'live', '', '', '', '']],
    statuses: { 'com.vasu.app': 404 },
  });
  const result = await runOnce({ config: baseConfig(), ...s, now });

  assert.equal(s.sent.length, 0);
  assert.equal(result.summary.marked, 1);
  assert.equal(result.summary.flipped, 0);
  assert.equal(s.written[0].rows[0].pendingFlip, 'removed');
  assert.equal(s.written[0].rows[0].status, 'live', 'status is unchanged until confirmed');
});

test('an app appearing flips and alerts on its very first sighting', async () => {
  const s = stubs({
    values: [['com.vasu.app', '', '', 'pending', '', '', '', '']],
    statuses: { 'com.vasu.app': 200 },
    details: { 'com.vasu.app': { appName: 'Vasu App Name', developer: 'VASU COMPANY LLC' } },
  });
  const result = await runOnce({ config: baseConfig(), ...s, now });

  assert.equal(result.summary.flipped, 1);
  assert.equal(result.summary.marked, 0, 'additions never sit in the marker');
  assert.equal(s.sent.length, 2);
  assert.equal(s.sent[0].templateName, 'play_store_app_added');

  const row = s.written[0].rows[0];
  assert.equal(row.status, 'live');
  assert.equal(row.firstLive, '2026-09-03 14:51');
  assert.equal(row.pendingFlip, '');
});

test('a confirmed sighting flips to live and messages every recipient', async () => {
  const s = stubs({
    values: [['com.vasu.app', '', '', 'pending', '', '', '', 'live']],
    statuses: { 'com.vasu.app': 200 },
    details: { 'com.vasu.app': { appName: 'Vasu App Name', developer: 'VASU COMPANY LLC' } },
  });
  const result = await runOnce({ config: baseConfig(), ...s, now });

  assert.equal(result.summary.flipped, 1);
  assert.equal(s.sent.length, 2, 'one message per recipient');
  assert.equal(s.sent[0].templateName, 'play_store_app_added');
  assert.deepEqual(s.sent[0].params.slice(0, 5), [
    'VASU COMPANY LLC',
    '0',
    '1',
    'Vasu App Name',
    'com.vasu.app',
  ]);

  const row = s.written[0].rows[0];
  assert.equal(row.status, 'live');
  assert.equal(row.appName, 'Vasu App Name');
  assert.equal(row.developer, 'VASU COMPANY LLC');
  assert.equal(row.firstLive, '2026-09-03 14:51');
  assert.equal(row.lastChange, '2026-09-03 14:51');
  assert.equal(row.pendingFlip, '');
});

test('a confirmed disappearance flips to removed and stamps the date', async () => {
  const s = stubs({
    values: [
      ['com.vasu.app', 'Vasu App Name', 'VASU COMPANY LLC', 'live', '2026-08-14 09:20', '', '', 'removed'],
    ],
    statuses: { 'com.vasu.app': 404 },
  });
  await runOnce({ config: baseConfig(), ...s, now });

  assert.equal(s.sent[0].templateName, 'play_store_app_removed');
  assert.deepEqual(s.sent[0].params.slice(1, 3), ['1', '0']);

  const row = s.written[0].rows[0];
  assert.equal(row.status, 'removed');
  assert.equal(row.lastRemoved, '2026-09-03 14:51');
  assert.equal(row.firstLive, '2026-08-14 09:20', 'first live is never overwritten');
});

test('an unknown result changes nothing at all', async () => {
  const s = stubs({
    values: [['com.vasu.app', 'A', 'D', 'live', '', '', '', '']],
    statuses: { 'com.vasu.app': 429 },
  });
  const result = await runOnce({ config: baseConfig(), ...s, now });

  assert.equal(s.sent.length, 0);
  assert.equal(s.written[0].rows.length, 0, 'no row updates, only the heartbeat');
  assert.equal(result.summary.unknown, 1);
});

test('a failed send leaves the row unwritten so the next run retries', async () => {
  const s = stubs({
    values: [['com.vasu.app', '', '', 'pending', '', '', '', 'live']],
    statuses: { 'com.vasu.app': 200 },
    details: { 'com.vasu.app': { appName: 'Vasu App Name', developer: 'VASU COMPANY LLC' } },
    sendResult: { ok: false, error: 'HTTP 400' },
  });
  const result = await runOnce({ config: baseConfig(), ...s, now });

  assert.equal(s.written[0].rows.length, 0, 'the flip must not be persisted');
  assert.equal(result.summary.sendFailures > 0, true);
  assert.equal(result.exitCode, 1);
});

test('a flip to live is abandoned when the app page cannot be parsed', async () => {
  const s = stubs({
    values: [['com.vasu.app', '', '', 'pending', '', '', '', 'live']],
    statuses: { 'com.vasu.app': 200 },
    details: {},
  });
  await runOnce({ config: baseConfig(), ...s, now });

  assert.equal(s.sent.length, 0);
  assert.equal(s.written[0].rows.length, 0);
});

test('invalid package names are marked invalid and never requested', async () => {
  const s = stubs({ values: [['not-a-package']], statuses: {} });
  let requested = null;
  s.playstore.checkAll = async (packages) => {
    requested = packages;
    return new Map();
  };

  const result = await runOnce({ config: baseConfig(), ...s, now });
  assert.deepEqual(requested, []);
  assert.equal(result.summary.invalid, 1);
  assert.equal(s.written[0].rows[0].status, 'invalid');
});

test('the canary reading gone is healthy and silent', async () => {
  const s = stubs({
    values: [[CANARY, '', '', 'pending', '', '', '', '']],
    statuses: { [CANARY]: 404 },
  });
  const result = await runOnce({ config: baseConfig(), ...s, now });

  assert.equal(result.exitCode, 0);
  assert.equal(result.summary.canaryBroken, false);
  assert.equal(s.sent.length, 0);
});

test('the canary reading live fails the run and sends no message', async () => {
  const s = stubs({
    values: [[CANARY, '', '', 'pending', '', '', '', 'live']],
    statuses: { [CANARY]: 200 },
    details: { [CANARY]: { appName: 'Canary', developer: 'Nobody' } },
  });
  const result = await runOnce({ config: baseConfig(), ...s, now });

  assert.equal(result.summary.canaryBroken, true);
  assert.equal(result.exitCode, 1);
  assert.equal(s.sent.length, 0);
});

test('a run that is mostly unknown fails so GitHub emails about it', async () => {
  const s = stubs({
    values: [
      ['com.vasu.a', '', '', 'live', '', '', '', ''],
      ['com.vasu.b', '', '', 'live', '', '', '', ''],
      ['com.vasu.c', '', '', 'live', '', '', '', ''],
    ],
    statuses: { 'com.vasu.a': 429, 'com.vasu.b': 503, 'com.vasu.c': 200 },
  });
  const result = await runOnce({ config: baseConfig(), ...s, now });
  assert.equal(result.exitCode, 1);
});

test('dry run neither writes to the sheet nor sends messages', async () => {
  const s = stubs({
    values: [['com.vasu.app', '', '', 'pending', '', '', '', 'live']],
    statuses: { 'com.vasu.app': 200 },
    details: { 'com.vasu.app': { appName: 'Vasu App Name', developer: 'VASU COMPANY LLC' } },
  });
  const result = await runOnce({ config: baseConfig({ dryRun: true }), ...s, now });

  assert.equal(s.written.length, 0);
  assert.equal(s.sent.length, 0);
  assert.equal(result.summary.flipped, 1, 'the flip is still computed and reported');
});

test('a message that fails for one recipient still counts as a failure', async () => {
  const s = stubs({
    values: [['com.vasu.app', '', '', 'pending', '', '', '', 'live']],
    statuses: { 'com.vasu.app': 200 },
    details: { 'com.vasu.app': { appName: 'Vasu App Name', developer: 'VASU COMPANY LLC' } },
  });
  let call = 0;
  s.whatsapp.sendTemplate = async () => {
    call += 1;
    return call === 1 ? { ok: true, error: null } : { ok: false, error: 'HTTP 500' };
  };

  const result = await runOnce({ config: baseConfig(), ...s, now });
  assert.equal(s.written[0].rows.length, 0, 'a partial delivery must retry');
  assert.equal(result.summary.sendFailures, 1);
});

test('suppressed alerts record the flip in full but send nothing', async () => {
  const s = stubs({
    values: [['com.vasu.app', '', '', 'pending', '', '', '', 'live']],
    statuses: { 'com.vasu.app': 200 },
    details: { 'com.vasu.app': { appName: 'Vasu App Name', developer: 'VASU COMPANY LLC' } },
  });
  const result = await runOnce({ config: baseConfig({ suppressAlerts: true }), ...s, now });

  assert.equal(s.sent.length, 0, 'no messages are sent');

  // Unlike dry run, the flip IS persisted. That is the whole point: adopt the
  // current state once, so later runs only alert on genuine changes.
  const row = s.written[0].rows[0];
  assert.equal(row.status, 'live');
  assert.equal(row.appName, 'Vasu App Name');
  assert.equal(row.developer, 'VASU COMPANY LLC');
  assert.equal(row.firstLive, '2026-09-03 14:51');
  assert.equal(row.pendingFlip, '');

  assert.equal(result.summary.flipped, 1);
  assert.equal(result.summary.sent, 0);
  assert.equal(result.summary.sendFailures, 0);
  assert.equal(result.exitCode, 0, 'suppressing is not a failure');
});

test('suppressed alerts also record removals', async () => {
  const s = stubs({
    values: [
      ['com.vasu.app', 'Vasu App Name', 'VASU COMPANY LLC', 'live', '2026-08-14 09:20', '', '', 'removed'],
    ],
    statuses: { 'com.vasu.app': 404 },
  });
  const result = await runOnce({ config: baseConfig({ suppressAlerts: true }), ...s, now });

  assert.equal(s.sent.length, 0);
  assert.equal(s.written[0].rows[0].status, 'removed');
  assert.equal(s.written[0].rows[0].lastRemoved, '2026-09-03 14:51');
  assert.equal(result.exitCode, 0);
});

test('the summary never contains a package name, app name or developer', async () => {
  const s = stubs({
    values: [['com.vasu.app', 'Vasu App Name', 'VASU COMPANY LLC', 'live', '', '', '', '']],
    statuses: { 'com.vasu.app': 200 },
  });
  const result = await runOnce({ config: baseConfig(), ...s, now });
  const serialized = JSON.stringify(result.summary);
  assert.doesNotMatch(serialized, /com\.vasu/);
  assert.doesNotMatch(serialized, /Vasu App Name/);
  assert.doesNotMatch(serialized, /VASU COMPANY/);
});
