import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  liveByDeveloper,
  findUnknownDevelopers,
  resolveRenames,
  applyRenames,
} from '../src/renames.js';

const CANARY = 'com.canary.doesnotexist.monitor';

/** Eight live apps under one account, as in the reported bug. */
function manchakRows() {
  return Array.from({ length: 8 }, (_, i) => ({
    packageName: `com.manchak.app${i}`,
    appName: `App ${i}`,
    developer: 'Manchak Developer',
    status: 'live',
  }));
}

test('groups live packages by their recorded developer', () => {
  const rows = [
    ...manchakRows(),
    { packageName: 'com.other.a', developer: 'Acme Studio', status: 'live' },
    { packageName: 'com.other.b', developer: 'Acme Studio', status: 'removed' },
    { packageName: 'com.other.c', developer: '', status: 'live' },
    { packageName: CANARY, developer: 'Whatever', status: 'live' },
  ];

  const grouped = liveByDeveloper({ rows, canaryPackage: CANARY });

  assert.equal(grouped.get('Manchak Developer').length, 8);
  assert.equal(grouped.get('Acme Studio').length, 1, 'removed rows do not count');
  assert.equal(grouped.has(''), false, 'rows with no developer are skipped');
  assert.equal(grouped.has('Whatever'), false, 'the canary is excluded');
});

test('spots a developer name that no live row claims', () => {
  const rows = [...manchakRows(), { packageName: 'com.manchak.new', status: 'pending', developer: '' }];
  const unknown = findUnknownDevelopers({
    rows,
    flips: [{ packageName: 'com.manchak.new', to: 'live' }],
    details: new Map([['com.manchak.new', { appName: 'New', developer: 'Manoj Developer' }]]),
    canaryPackage: CANARY,
  });

  assert.deepEqual([...unknown], ['Manoj Developer']);
});

test('a familiar developer name raises nothing', () => {
  const rows = [...manchakRows(), { packageName: 'com.manchak.new', status: 'pending', developer: '' }];
  const unknown = findUnknownDevelopers({
    rows,
    flips: [{ packageName: 'com.manchak.new', to: 'live' }],
    details: new Map([['com.manchak.new', { appName: 'New', developer: 'Manchak Developer' }]]),
    canaryPackage: CANARY,
  });

  assert.equal(unknown.size, 0);
});

/** Store state: every Manchak app now reports the new name. */
function renamedStore(overrides = {}) {
  return {
    fetchDetails: async (packageName) => {
      if (packageName in overrides) return overrides[packageName];
      if (packageName.startsWith('com.manchak.')) {
        return { appName: 'x', developer: 'Manoj Developer' };
      }
      return { appName: 'x', developer: 'Acme Studio' };
    },
  };
}

const renameInput = () => ({
  rows: [...manchakRows(), { packageName: 'com.manchak.new', status: 'pending', developer: '' }],
  flips: [{ packageName: 'com.manchak.new', to: 'live' }],
  details: new Map([['com.manchak.new', { appName: 'New App', developer: 'Manoj Developer' }]]),
  region: 'US',
  canaryPackage: CANARY,
});

test('detects the rename by re-reading an existing app', async () => {
  const renames = await resolveRenames({ ...renameInput(), playstore: renamedStore() });
  assert.deepEqual([...renames], [['Manchak Developer', 'Manoj Developer']]);
});

test('skips a probe page that cannot be read and tries the next', async () => {
  const playstore = renamedStore({ 'com.manchak.app0': null });
  const renames = await resolveRenames({ ...renameInput(), playstore });
  assert.deepEqual([...renames], [['Manchak Developer', 'Manoj Developer']]);
});

test('a genuinely new account produces no rename', async () => {
  const playstore = {
    // Every existing app still reports the name already on record.
    fetchDetails: async () => ({ appName: 'x', developer: 'Manchak Developer' }),
  };
  const renames = await resolveRenames({ ...renameInput(), playstore });
  assert.equal(renames.size, 0);
});

test('no probing at all when every developer name is familiar', async () => {
  let calls = 0;
  const playstore = {
    fetchDetails: async () => {
      calls += 1;
      return { appName: 'x', developer: 'Manchak Developer' };
    },
  };

  const renames = await resolveRenames({
    ...renameInput(),
    details: new Map([['com.manchak.new', { appName: 'New', developer: 'Manchak Developer' }]]),
    playstore,
  });

  assert.equal(renames.size, 0);
  assert.equal(calls, 0, 'a normal run must cost no extra requests');
});

test('rewrites every affected row and queues it for writing', () => {
  const rows = manchakRows();
  const changedRows = new Map();
  const touched = applyRenames({
    rows,
    changedRows,
    renames: new Map([['Manchak Developer', 'Manoj Developer']]),
  });

  assert.equal(touched.length, 8);
  assert.ok(rows.every((r) => r.developer === 'Manoj Developer'));
  assert.equal(changedRows.size, 8);
  assert.equal(changedRows.get('com.manchak.app0').developer, 'Manoj Developer');
});

test('keeps an already-queued row intact while renaming it', () => {
  const rows = manchakRows();
  const changedRows = new Map([
    ['com.manchak.app0', { ...rows[0], pendingFlip: 'removed' }],
  ]);

  applyRenames({ rows, changedRows, renames: new Map([['Manchak Developer', 'Manoj Developer']]) });

  const queued = changedRows.get('com.manchak.app0');
  assert.equal(queued.developer, 'Manoj Developer');
  assert.equal(queued.pendingFlip, 'removed', 'the pending flip must survive the rename');
});

test('leaves rows alone when there is nothing to rename', () => {
  const rows = manchakRows();
  const changedRows = new Map();
  assert.deepEqual(applyRenames({ rows, changedRows, renames: new Map() }), []);
  assert.equal(changedRows.size, 0);
});
