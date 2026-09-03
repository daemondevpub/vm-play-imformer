import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidPackage, parseRows, rowToCells } from '../src/rows.js';

test('accepts well formed package names', () => {
  assert.equal(isValidPackage('com.vasu.app'), true);
  assert.equal(isValidPackage('com.vasu.flash_light.pro'), true);
  assert.equal(isValidPackage('a.b'), true);
});

test('rejects malformed package names', () => {
  assert.equal(isValidPackage('novodots'), false);
  assert.equal(isValidPackage('1com.vasu.app'), false);
  assert.equal(isValidPackage('com..vasu'), false);
  assert.equal(isValidPackage('com.vasu.app '), false);
  assert.equal(isValidPackage('com.vasu-app.x'), false);
  assert.equal(isValidPackage(''), false);
});

test('parses a populated row into a Row object', () => {
  const { rows } = parseRows([
    ['com.vasu.app', 'Vasu App', 'VASU COMPANY LLC', 'live', '2026-08-14 09:20', '', '2026-08-14 09:20', ''],
  ]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    rowNumber: 2,
    packageName: 'com.vasu.app',
    appName: 'Vasu App',
    developer: 'VASU COMPANY LLC',
    status: 'live',
    firstLive: '2026-08-14 09:20',
    lastRemoved: '',
    lastChange: '2026-08-14 09:20',
    pendingFlip: '',
  });
});

test('a brand new package with no other columns starts as pending', () => {
  const { rows } = parseRows([['com.vasu.newapp']]);
  assert.equal(rows[0].status, 'pending');
  assert.equal(rows[0].appName, '');
  assert.equal(rows[0].developer, '');
});

test('row numbers account for the header and for blank rows', () => {
  const { rows } = parseRows([
    ['com.vasu.one'],
    [''],
    ['com.vasu.two'],
  ]);
  assert.deepEqual(rows.map((row) => row.rowNumber), [2, 4]);
});

test('blank and whitespace-only package cells are skipped entirely', () => {
  const { rows } = parseRows([[''], ['   '], [], ['com.vasu.app']]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].packageName, 'com.vasu.app');
});

test('package names are trimmed', () => {
  const { rows } = parseRows([['  com.vasu.app  ']]);
  assert.equal(rows[0].packageName, 'com.vasu.app');
});

test('duplicates are removed case-insensitively, first occurrence wins', () => {
  const { rows, duplicates } = parseRows([
    ['com.vasu.app', '', '', 'live'],
    ['COM.VASU.APP', '', '', 'removed'],
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'live');
  assert.equal(rows[0].rowNumber, 2);
  assert.equal(duplicates, 1);
});

test('malformed package names are marked invalid rather than dropped', () => {
  const { rows } = parseRows([['not-a-package']]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'invalid');
});

test('an unrecognised status value falls back to pending', () => {
  const { rows } = parseRows([['com.vasu.app', '', '', 'weird']]);
  assert.equal(rows[0].status, 'pending');
});

test('status parsing is case-insensitive and trimmed', () => {
  const { rows } = parseRows([['com.vasu.app', '', '', ' LIVE ']]);
  assert.equal(rows[0].status, 'live');
});

test('serializes a row into exactly seven cells for columns B through H', () => {
  const [row] = parseRows([
    ['com.vasu.app', 'Vasu App', 'VASU COMPANY LLC', 'live', '2026-08-14 09:20', '2026-09-01 14:05', '2026-09-01 14:05', 'removed'],
  ]).rows;
  assert.deepEqual(rowToCells(row), [
    'Vasu App',
    'VASU COMPANY LLC',
    'live',
    '2026-08-14 09:20',
    '2026-09-01 14:05',
    '2026-09-01 14:05',
    'removed',
  ]);
});
