import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatIstTime, formatIstDateTime } from '../src/time.js';

// 2026-09-03T09:21:00Z is 2:51 PM in Asia/Kolkata (UTC+05:30).
const sample = new Date('2026-09-03T09:21:00Z');

test('formats an IST clock time', () => {
  assert.equal(formatIstTime(sample), '2:51 PM');
});

test('formats an IST date and time', () => {
  assert.equal(formatIstDateTime(sample), '2026-09-03 14:51');
});

test('renders midnight IST as 12:00 AM on the correct date', () => {
  // 2026-09-02T18:30:00Z is exactly 2026-09-03 00:00 IST.
  const midnight = new Date('2026-09-02T18:30:00Z');
  assert.equal(formatIstTime(midnight), '12:00 AM');
  assert.equal(formatIstDateTime(midnight), '2026-09-03 00:00');
});

test('renders noon IST as 12:00 PM', () => {
  const noon = new Date('2026-09-03T06:30:00Z');
  assert.equal(formatIstTime(noon), '12:00 PM');
});
