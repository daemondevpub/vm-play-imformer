import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, sequenceCounts } from '../src/transitions.js';
import { EXISTS, GONE, UNKNOWN } from '../src/classify.js';

test('an unknown result never changes anything', () => {
  for (const status of ['pending', 'live', 'removed']) {
    for (const pendingFlip of ['', 'live', 'removed']) {
      assert.deepEqual(decide({ status, result: UNKNOWN, pendingFlip }), { action: 'none' });
    }
  }
});

test('a pending app that is still absent stays silent', () => {
  assert.deepEqual(decide({ status: 'pending', result: GONE, pendingFlip: '' }), { action: 'none' });
});

test('a pending app that is absent clears a stale marker', () => {
  assert.deepEqual(decide({ status: 'pending', result: GONE, pendingFlip: 'live' }), { action: 'clear' });
});

test('a pending app flips to live on a single sighting', () => {
  assert.deepEqual(decide({ status: 'pending', result: EXISTS, pendingFlip: '' }), {
    action: 'flip',
    to: 'live',
  });
});

test('a stale marker does not delay an addition', () => {
  for (const pendingFlip of ['', 'live', 'removed']) {
    assert.deepEqual(decide({ status: 'pending', result: EXISTS, pendingFlip }), {
      action: 'flip',
      to: 'live',
    });
  }
});

test('a live app missing once is only marked', () => {
  assert.deepEqual(decide({ status: 'live', result: GONE, pendingFlip: '' }), {
    action: 'mark',
    to: 'removed',
  });
});

test('a live app missing twice flips to removed', () => {
  assert.deepEqual(decide({ status: 'live', result: GONE, pendingFlip: 'removed' }), {
    action: 'flip',
    to: 'removed',
  });
});

test('a live app that is still present clears a stale marker', () => {
  assert.deepEqual(decide({ status: 'live', result: EXISTS, pendingFlip: 'removed' }), { action: 'clear' });
  assert.deepEqual(decide({ status: 'live', result: EXISTS, pendingFlip: '' }), { action: 'none' });
});

test('a removed app returning flips back to live immediately', () => {
  assert.deepEqual(decide({ status: 'removed', result: EXISTS, pendingFlip: '' }), {
    action: 'flip',
    to: 'live',
  });
});

test('confirmation is asymmetric: removals wait, additions do not', () => {
  // A disappearance is only recorded on the first sighting.
  assert.deepEqual(decide({ status: 'live', result: GONE, pendingFlip: '' }), {
    action: 'mark',
    to: 'removed',
  });
  // It takes a second consecutive sighting to apply.
  assert.deepEqual(decide({ status: 'live', result: GONE, pendingFlip: 'removed' }), {
    action: 'flip',
    to: 'removed',
  });
  // An appearance applies straight away.
  assert.deepEqual(decide({ status: 'removed', result: EXISTS, pendingFlip: '' }), {
    action: 'flip',
    to: 'live',
  });
});

test('a removed app that is still absent clears a stale marker', () => {
  assert.deepEqual(decide({ status: 'removed', result: GONE, pendingFlip: 'live' }), { action: 'clear' });
  assert.deepEqual(decide({ status: 'removed', result: GONE, pendingFlip: '' }), { action: 'none' });
});

test('a marker for the opposite direction is replaced, not honoured', () => {
  assert.deepEqual(decide({ status: 'live', result: GONE, pendingFlip: 'live' }), {
    action: 'mark',
    to: 'removed',
  });
});

const CANARY = 'com.canary.doesnotexist.monitor';

test('an app going live increments its developer count', () => {
  const rows = [
    { packageName: 'com.vasu.a', status: 'live', developer: 'VASU COMPANY LLC' },
    { packageName: 'com.vasu.b', status: 'pending', developer: '' },
  ];
  const events = sequenceCounts({
    rows,
    flips: [{ packageName: 'com.vasu.b', to: 'live' }],
    details: new Map([['com.vasu.b', { appName: 'Vasu App Name', developer: 'VASU COMPANY LLC' }]]),
    canaryPackage: CANARY,
  });
  assert.deepEqual(events, [
    {
      type: 'added',
      packageName: 'com.vasu.b',
      appName: 'Vasu App Name',
      developer: 'VASU COMPANY LLC',
      countBefore: 1,
      countAfter: 2,
    },
  ]);
});

test('an app being removed decrements its developer count', () => {
  const rows = [
    { packageName: 'com.vasu.a', status: 'live', developer: 'VASU COMPANY LLC' },
    { packageName: 'com.vasu.b', status: 'live', developer: 'VASU COMPANY LLC', appName: 'Vasu App Name' },
  ];
  const events = sequenceCounts({
    rows,
    flips: [{ packageName: 'com.vasu.b', to: 'removed' }],
    details: new Map(),
    canaryPackage: CANARY,
  });
  assert.deepEqual(events, [
    {
      type: 'removed',
      packageName: 'com.vasu.b',
      appName: 'Vasu App Name',
      developer: 'VASU COMPANY LLC',
      countBefore: 2,
      countAfter: 1,
    },
  ]);
});

test('several flips for one developer produce a running count', () => {
  const rows = [
    { packageName: 'com.vasu.a', status: 'live', developer: 'VASU COMPANY LLC' },
    { packageName: 'com.vasu.b', status: 'pending', developer: '' },
    { packageName: 'com.vasu.c', status: 'pending', developer: '' },
  ];
  const details = new Map([
    ['com.vasu.b', { appName: 'B', developer: 'VASU COMPANY LLC' }],
    ['com.vasu.c', { appName: 'C', developer: 'VASU COMPANY LLC' }],
  ]);
  const events = sequenceCounts({
    rows,
    flips: [
      { packageName: 'com.vasu.b', to: 'live' },
      { packageName: 'com.vasu.c', to: 'live' },
    ],
    details,
    canaryPackage: CANARY,
  });
  assert.deepEqual(
    events.map((event) => [event.countBefore, event.countAfter]),
    [
      [1, 2],
      [2, 3],
    ],
  );
});

test('counts are tracked per developer, not globally', () => {
  const rows = [
    { packageName: 'com.a.one', status: 'live', developer: 'ACME STUDIO' },
    { packageName: 'com.a.two', status: 'live', developer: 'ACME STUDIO' },
    { packageName: 'com.v.one', status: 'pending', developer: '' },
  ];
  const events = sequenceCounts({
    rows,
    flips: [{ packageName: 'com.v.one', to: 'live' }],
    details: new Map([['com.v.one', { appName: 'V One', developer: 'VASU COMPANY LLC' }]]),
    canaryPackage: CANARY,
  });
  assert.deepEqual([events[0].countBefore, events[0].countAfter], [0, 1]);
});

test('the canary never produces an event and never affects counts', () => {
  const rows = [
    { packageName: 'com.vasu.a', status: 'live', developer: 'VASU COMPANY LLC' },
    { packageName: CANARY, status: 'pending', developer: '' },
  ];
  const events = sequenceCounts({
    rows,
    flips: [{ packageName: CANARY, to: 'live' }],
    details: new Map([[CANARY, { appName: 'Canary', developer: 'VASU COMPANY LLC' }]]),
    canaryPackage: CANARY,
  });
  assert.deepEqual(events, []);
});

test('a removal for an app with no recorded developer falls back to Unknown', () => {
  const rows = [{ packageName: 'com.vasu.b', status: 'live', developer: '', appName: 'B' }];
  const events = sequenceCounts({
    rows,
    flips: [{ packageName: 'com.vasu.b', to: 'removed' }],
    details: new Map(),
    canaryPackage: CANARY,
  });
  assert.equal(events[0].developer, 'Unknown');
});

test('a flip to live with no details is skipped rather than guessed', () => {
  const rows = [{ packageName: 'com.vasu.b', status: 'pending', developer: '' }];
  const events = sequenceCounts({
    rows,
    flips: [{ packageName: 'com.vasu.b', to: 'live' }],
    details: new Map(),
    canaryPackage: CANARY,
  });
  assert.deepEqual(events, []);
});
