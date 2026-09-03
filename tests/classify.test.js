import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, EXISTS, GONE, UNKNOWN } from '../src/classify.js';

test('200 means the listing exists', () => {
  assert.equal(classify(200), EXISTS);
});

test('404 means the listing is gone', () => {
  assert.equal(classify(404), GONE);
});

test('throttling and server errors are unknown, never a state change', () => {
  for (const code of [301, 403, 429, 500, 502, 503]) {
    assert.equal(classify(code), UNKNOWN, `expected ${code} to be unknown`);
  }
});

test('a network failure reported as null is unknown', () => {
  assert.equal(classify(null), UNKNOWN);
});

test('the constants are the documented strings', () => {
  assert.equal(EXISTS, 'exists');
  assert.equal(GONE, 'gone');
  assert.equal(UNKNOWN, 'unknown');
});
