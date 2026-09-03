import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeParam, buildMessage } from '../src/messages.js';

test('collapses newlines and tabs that Meta rejects', () => {
  assert.equal(sanitizeParam('Flash\nLight\tPro'), 'Flash Light Pro');
});

test('collapses runs of spaces to a single space', () => {
  assert.equal(sanitizeParam('Flash        Light'), 'Flash Light');
});

test('strips characters Meta rejects in parameters', () => {
  assert.equal(sanitizeParam('100% Free VPN'), '100 Free VPN');
  assert.equal(sanitizeParam('Photo Editor #1'), 'Photo Editor 1');
  assert.equal(sanitizeParam('Cash$ Rewards'), 'Cash Rewards');
});

test('trims and tolerates non-string input', () => {
  assert.equal(sanitizeParam('  spaced  '), 'spaced');
  assert.equal(sanitizeParam(12), '12');
  assert.equal(sanitizeParam(0), '0');
  assert.equal(sanitizeParam(null), '-');
  assert.equal(sanitizeParam(undefined), '-');
});

test('never returns an empty parameter, since Meta rejects those', () => {
  assert.equal(sanitizeParam('###'), '-');
  assert.equal(sanitizeParam(''), '-');
});

test('truncates very long values so the rendered body stays under the limit', () => {
  const long = 'A'.repeat(200);
  const result = sanitizeParam(long);
  assert.equal(result.length, 60);
  assert.ok(result.endsWith('...'));
});

const now = new Date('2026-09-03T09:21:00Z'); // 2:51 PM IST

const templates = { templateAdded: 'play_store_app_added', templateRemoved: 'play_store_app_removed' };

test('builds the added message', () => {
  const message = buildMessage({
    event: {
      type: 'added',
      packageName: 'com.vasu.app',
      appName: 'Vasu App Name',
      developer: 'VASU COMPANY LLC',
      countBefore: 12,
      countAfter: 13,
    },
    now,
    ...templates,
  });
  assert.equal(message.templateName, 'play_store_app_added');
  assert.deepEqual(message.params, [
    'VASU COMPANY LLC',
    '12',
    '13',
    'Vasu App Name',
    'com.vasu.app',
    '2:51 PM',
  ]);
});

test('builds the removed message', () => {
  const message = buildMessage({
    event: {
      type: 'removed',
      packageName: 'com.vasu.app',
      appName: 'Vasu App Name',
      developer: 'VASU COMPANY LLC',
      countBefore: 13,
      countAfter: 12,
    },
    now,
    ...templates,
  });
  assert.equal(message.templateName, 'play_store_app_removed');
  assert.deepEqual(message.params.slice(1, 3), ['13', '12']);
});

test('sanitizes every parameter it emits', () => {
  const message = buildMessage({
    event: {
      type: 'added',
      packageName: 'com.vasu.app',
      appName: '100%\nFree  \t  VPN',
      developer: 'VASU  &  CO',
      countBefore: 0,
      countAfter: 1,
    },
    now,
    ...templates,
  });
  assert.deepEqual(message.params[3], '100 Free VPN');
  assert.deepEqual(message.params[0], 'VASU & CO');
  for (const param of message.params) {
    assert.doesNotMatch(param, /[\n\t#$%]/);
    assert.doesNotMatch(param, / {4}/);
    assert.notEqual(param, '');
  }
});

test('falls back to the package name when the app name is unusable', () => {
  const message = buildMessage({
    event: {
      type: 'added',
      packageName: 'com.vasu.app',
      appName: '',
      developer: 'VASU COMPANY LLC',
      countBefore: 0,
      countAfter: 1,
    },
    now,
    ...templates,
  });
  assert.equal(message.params[3], 'com.vasu.app');
});
