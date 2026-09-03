# Play Store Listing Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect when a Google Play listing appears or disappears and send a WhatsApp alert to two people within roughly 20 minutes, running entirely on free services.

**Architecture:** A Node.js script run by a GitHub Actions cron every 10 minutes. Pure logic modules (classification, state transitions, message building) are separated from I/O adapters (Play Store, Google Sheets, Meta WhatsApp) so nearly everything is unit-testable without a network. A Google Sheet is the single source of truth, since Actions runs are stateless.

**Tech Stack:** Node.js 22 (ESM), the built-in `node:test` runner, native `fetch`, and one runtime dependency, `google-auth-library`, for service-account JWT signing.

**Reference spec:** `docs/superpowers/specs/2026-09-03-play-store-monitor-design.md`

## Global Constraints

- Node.js `>=20`, ESM only (`"type": "module"`). CI pins Node `22`.
- Exactly one runtime dependency: `google-auth-library`. No dev dependencies; tests use `node:test` and `node:assert/strict`.
- **Logs must never contain package names, app names, or developer accounts** unless dry-run mode is on. Repository Actions logs are public.
- Repo-local git identity is already set to `play-store-monitor <play-store-monitor@users.noreply.github.com>`. Do not change it and do not commit with a personal identity.
- All timestamps rendered in `Asia/Kolkata`.
- Statuses are exactly the strings `pending`, `live`, `removed`, `invalid`.
- Check results are exactly the strings `exists`, `gone`, `unknown`.
- Sheet columns: A package name (user-owned, never written), B app name, C developer account, D status, E first live, F last removed, G last change, H internal pending-flip marker. `J2` holds the last-run timestamp.
- WhatsApp template names: `play_store_app_added`, `play_store_app_removed`. Template parameter values must never contain newlines, tabs, runs of 4+ spaces, or the characters `#`, `$`, `%`.
- A state change requires the same observation on two consecutive runs before it is applied.
- Canary package `com.canary.doesnotexist.monitor` must always classify as gone; it is excluded from counts and never generates a message.

---

### Task 1: Project scaffold, configuration, and logger

**Files:**
- Create: `package.json`
- Create: `src/config.js`
- Create: `src/logger.js`
- Test: `tests/config.test.js`
- Test: `tests/logger.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `loadConfig(env: object) => Config` where `Config` is `{ sheetId: string, sheetTab: string, serviceAccount: object, metaToken: string|null, metaPhoneNumberId: string|null, metaApiVersion: string, templateLanguage: string, recipients: string[], templateAdded: string, templateRemoved: string, playRegion: string, concurrency: number, canaryPackage: string, dryRun: boolean }`. Throws `Error` on invalid input.
  - `createLogger({ verbose: boolean }) => { info(msg), warn(msg), error(msg), detail(msg) }` where `detail` prints only when `verbose` is true.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "vm-play-imformer",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "description": "Monitors Google Play listings and sends WhatsApp alerts when they appear or disappear.",
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "test": "node --test tests/",
    "start": "node src/index.js"
  },
  "dependencies": {
    "google-auth-library": "^9.14.0"
  }
}
```

- [ ] **Step 2: Install dependencies to generate the lockfile**

Run: `npm install`
Expected: creates `node_modules/` and `package-lock.json`, exits 0.

- [ ] **Step 3: Write the failing config test**

Create `tests/config.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const baseEnv = {
  SHEET_ID: 'sheet-123',
  GOOGLE_SERVICE_ACCOUNT_JSON: '{"client_email":"a@b.iam.gserviceaccount.com","private_key":"x"}',
  META_ACCESS_TOKEN: 'token-abc',
  META_PHONE_NUMBER_ID: '999888777',
  WHATSAPP_RECIPIENTS: '919876543210, 919812345678',
};

test('loads a fully specified environment', () => {
  const config = loadConfig(baseEnv);
  assert.equal(config.sheetId, 'sheet-123');
  assert.equal(config.serviceAccount.client_email, 'a@b.iam.gserviceaccount.com');
  assert.deepEqual(config.recipients, ['919876543210', '919812345678']);
  assert.equal(config.dryRun, false);
});

test('applies documented defaults', () => {
  const config = loadConfig(baseEnv);
  assert.equal(config.sheetTab, 'Apps');
  assert.equal(config.playRegion, 'US');
  assert.equal(config.concurrency, 20);
  assert.equal(config.templateAdded, 'play_store_app_added');
  assert.equal(config.templateRemoved, 'play_store_app_removed');
  assert.equal(config.templateLanguage, 'en');
  assert.equal(config.canaryPackage, 'com.canary.doesnotexist.monitor');
});

test('overrides defaults from the environment', () => {
  const config = loadConfig({ ...baseEnv, PLAY_REGION: 'IN', CONCURRENCY: '5', SHEET_TAB: 'Sheet1' });
  assert.equal(config.playRegion, 'IN');
  assert.equal(config.concurrency, 5);
  assert.equal(config.sheetTab, 'Sheet1');
});

test('dry run does not require Meta credentials', () => {
  const config = loadConfig({
    SHEET_ID: 'sheet-123',
    GOOGLE_SERVICE_ACCOUNT_JSON: baseEnv.GOOGLE_SERVICE_ACCOUNT_JSON,
    DRY_RUN: 'true',
  });
  assert.equal(config.dryRun, true);
  assert.equal(config.metaToken, null);
  assert.deepEqual(config.recipients, []);
});

test('rejects a missing sheet id', () => {
  const env = { ...baseEnv };
  delete env.SHEET_ID;
  assert.throws(() => loadConfig(env), /SHEET_ID/);
});

test('rejects Meta credentials missing outside dry run', () => {
  const env = { ...baseEnv };
  delete env.META_ACCESS_TOKEN;
  assert.throws(() => loadConfig(env), /META_ACCESS_TOKEN/);
});

test('rejects service account JSON that is not valid JSON', () => {
  assert.throws(() => loadConfig({ ...baseEnv, GOOGLE_SERVICE_ACCOUNT_JSON: 'not json' }), /GOOGLE_SERVICE_ACCOUNT_JSON/);
});

test('rejects a service account without client_email or private_key', () => {
  assert.throws(
    () => loadConfig({ ...baseEnv, GOOGLE_SERVICE_ACCOUNT_JSON: '{"client_email":"a@b.com"}' }),
    /private_key/,
  );
});

test('rejects a non-numeric concurrency', () => {
  assert.throws(() => loadConfig({ ...baseEnv, CONCURRENCY: 'lots' }), /CONCURRENCY/);
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="config"` or simply `node --test tests/config.test.js`
Expected: FAIL, cannot find module `../src/config.js`.

- [ ] **Step 5: Implement `src/config.js`**

```js
const DEFAULTS = {
  sheetTab: 'Apps',
  playRegion: 'US',
  concurrency: 20,
  metaApiVersion: 'v21.0',
  templateLanguage: 'en',
  templateAdded: 'play_store_app_added',
  templateRemoved: 'play_store_app_removed',
  canaryPackage: 'com.canary.doesnotexist.monitor',
};

function required(env, key) {
  const value = env[key];
  if (!value || !String(value).trim()) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return String(value).trim();
}

function parseServiceAccount(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON must be a JSON object');
  }
  if (!parsed.client_email) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email');
  }
  if (!parsed.private_key) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is missing private_key');
  }
  return parsed;
}

function parseConcurrency(raw) {
  if (raw === undefined || raw === '') return DEFAULTS.concurrency;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error('CONCURRENCY must be an integer between 1 and 100');
  }
  return value;
}

function parseRecipients(raw) {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function loadConfig(env = process.env) {
  const dryRun = String(env.DRY_RUN ?? '').toLowerCase() === 'true';

  const config = {
    dryRun,
    sheetId: required(env, 'SHEET_ID'),
    sheetTab: env.SHEET_TAB?.trim() || DEFAULTS.sheetTab,
    serviceAccount: parseServiceAccount(required(env, 'GOOGLE_SERVICE_ACCOUNT_JSON')),
    playRegion: env.PLAY_REGION?.trim() || DEFAULTS.playRegion,
    concurrency: parseConcurrency(env.CONCURRENCY),
    metaApiVersion: env.META_API_VERSION?.trim() || DEFAULTS.metaApiVersion,
    templateLanguage: env.TEMPLATE_LANGUAGE?.trim() || DEFAULTS.templateLanguage,
    templateAdded: env.TEMPLATE_ADDED?.trim() || DEFAULTS.templateAdded,
    templateRemoved: env.TEMPLATE_REMOVED?.trim() || DEFAULTS.templateRemoved,
    canaryPackage: env.CANARY_PACKAGE?.trim() || DEFAULTS.canaryPackage,
    metaToken: null,
    metaPhoneNumberId: null,
    recipients: [],
  };

  if (!dryRun) {
    config.metaToken = required(env, 'META_ACCESS_TOKEN');
    config.metaPhoneNumberId = required(env, 'META_PHONE_NUMBER_ID');
    config.recipients = parseRecipients(required(env, 'WHATSAPP_RECIPIENTS'));
    if (config.recipients.length === 0) {
      throw new Error('WHATSAPP_RECIPIENTS must contain at least one number');
    }
  }

  return config;
}
```

- [ ] **Step 6: Run the config test to verify it passes**

Run: `node --test tests/config.test.js`
Expected: PASS, 9 tests.

- [ ] **Step 7: Write the failing logger test**

Create `tests/logger.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../src/logger.js';

function capture() {
  const lines = [];
  return { sink: (line) => lines.push(line), lines };
}

test('info, warn and error always print', () => {
  const { sink, lines } = capture();
  const log = createLogger({ verbose: false, sink });
  log.info('checked 10');
  log.warn('slow');
  log.error('broken');
  assert.deepEqual(lines, ['checked 10', 'WARN: slow', 'ERROR: broken']);
});

test('detail is suppressed when not verbose', () => {
  const { sink, lines } = capture();
  const log = createLogger({ verbose: false, sink });
  log.detail('com.secret.app is live');
  assert.deepEqual(lines, []);
});

test('detail prints when verbose', () => {
  const { sink, lines } = capture();
  const log = createLogger({ verbose: true, sink });
  log.detail('com.secret.app is live');
  assert.deepEqual(lines, ['com.secret.app is live']);
});
```

- [ ] **Step 8: Run the logger test to verify it fails**

Run: `node --test tests/logger.test.js`
Expected: FAIL, cannot find module `../src/logger.js`.

- [ ] **Step 9: Implement `src/logger.js`**

```js
/**
 * Actions logs on a public repository are world-readable.
 * `info`, `warn` and `error` must only ever receive aggregate, non-identifying
 * text. `detail` is for package names and app names and prints only in dry run.
 */
export function createLogger({ verbose = false, sink = console.log } = {}) {
  return {
    info: (message) => sink(message),
    warn: (message) => sink(`WARN: ${message}`),
    error: (message) => sink(`ERROR: ${message}`),
    detail: (message) => {
      if (verbose) sink(message);
    },
  };
}
```

- [ ] **Step 10: Run the full suite**

Run: `npm test`
Expected: PASS, 12 tests, 0 failures.

- [ ] **Step 11: Create `.gitignore` additions and commit**

Confirm `.gitignore` already contains `node_modules/`. Then:

```bash
git add package.json package-lock.json src/config.js src/logger.js tests/config.test.js tests/logger.test.js
git commit -m "feat: add project scaffold, configuration loader and safe logger"
```

---

### Task 2: Time formatting and status classification

**Files:**
- Create: `src/time.js`
- Create: `src/classify.js`
- Test: `tests/time.test.js`
- Test: `tests/classify.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `formatIstTime(date: Date) => string` rendering `h:mm AM/PM`, e.g. `2:51 PM`.
  - `formatIstDateTime(date: Date) => string` rendering `YYYY-MM-DD HH:mm` on a 24-hour clock.
  - `EXISTS`, `GONE`, `UNKNOWN` string constants.
  - `classify(statusCode: number|null) => 'exists'|'gone'|'unknown'`.

- [ ] **Step 1: Write the failing time test**

Create `tests/time.test.js`:

```js
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
```

- [ ] **Step 2: Run the time test to verify it fails**

Run: `node --test tests/time.test.js`
Expected: FAIL, cannot find module `../src/time.js`.

- [ ] **Step 3: Implement `src/time.js`**

```js
const TIME_ZONE = 'Asia/Kolkata';

const timeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

const dateTimeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** Renders `h:mm AM/PM` in IST, e.g. "2:51 PM". */
export function formatIstTime(date) {
  // Some ICU builds emit a narrow no-break space before AM/PM.
  return timeFormatter.format(date).replace(/ /g, ' ');
}

/** Renders `YYYY-MM-DD HH:mm` in IST, e.g. "2026-09-03 14:51". */
export function formatIstDateTime(date) {
  const parts = Object.fromEntries(
    dateTimeFormatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  // en-US with hour12:false renders midnight as "24"; normalise it to "00".
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day} ${hour}:${parts.minute}`;
}
```

- [ ] **Step 4: Run the time test to verify it passes**

Run: `node --test tests/time.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the failing classify test**

Create `tests/classify.test.js`:

```js
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
```

- [ ] **Step 6: Run the classify test to verify it fails**

Run: `node --test tests/classify.test.js`
Expected: FAIL, cannot find module `../src/classify.js`.

- [ ] **Step 7: Implement `src/classify.js`**

```js
export const EXISTS = 'exists';
export const GONE = 'gone';
export const UNKNOWN = 'unknown';

/**
 * Maps an HTTP status code to a check result.
 * Only 200 and 404 are meaningful. Everything else, including throttling and
 * network failures (passed as null), is UNKNOWN and must never drive a state
 * change.
 */
export function classify(statusCode) {
  if (statusCode === 200) return EXISTS;
  if (statusCode === 404) return GONE;
  return UNKNOWN;
}
```

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: PASS, 21 tests, 0 failures.

- [ ] **Step 9: Commit**

```bash
git add src/time.js src/classify.js tests/time.test.js tests/classify.test.js
git commit -m "feat: add IST time formatting and store status classification"
```

---

### Task 3: Sheet row parsing, validation and serialization

**Files:**
- Create: `src/rows.js`
- Test: `tests/rows.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `isValidPackage(name: string) => boolean`.
  - `parseRows(values: string[][]) => { rows: Row[], duplicates: number }` where `values` is the raw `A2:H` range and `Row` is `{ rowNumber, packageName, appName, developer, status, firstLive, lastRemoved, lastChange, pendingFlip }`. `rowNumber` is the 1-based spreadsheet row.
  - `rowToCells(row: Row) => string[]` returning exactly seven values for columns B through H.

- [ ] **Step 1: Write the failing rows test**

Create `tests/rows.test.js`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/rows.test.js`
Expected: FAIL, cannot find module `../src/rows.js`.

- [ ] **Step 3: Implement `src/rows.js`**

```js
export const PACKAGE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/i;

const KNOWN_STATUSES = new Set(['pending', 'live', 'removed', 'invalid']);

/** The spreadsheet row where data begins, immediately after the header row. */
const FIRST_DATA_ROW = 2;

export function isValidPackage(name) {
  return typeof name === 'string' && PACKAGE_PATTERN.test(name);
}

function cell(values, index) {
  const value = values[index];
  return typeof value === 'string' ? value.trim() : '';
}

function normaliseStatus(raw, packageName) {
  if (!isValidPackage(packageName)) return 'invalid';
  const status = raw.toLowerCase();
  if (!KNOWN_STATUSES.has(status) || status === 'invalid') return 'pending';
  return status;
}

/**
 * Converts the raw A2:H range into Row objects.
 * Rows are matched to packages by column A rather than by position, so the
 * user inserting or deleting rows between runs is safe.
 */
export function parseRows(values = []) {
  const rows = [];
  const seen = new Set();
  let duplicates = 0;

  values.forEach((raw, index) => {
    const columns = Array.isArray(raw) ? raw : [];
    const packageName = cell(columns, 0);
    if (!packageName) return;

    const key = packageName.toLowerCase();
    if (seen.has(key)) {
      duplicates += 1;
      return;
    }
    seen.add(key);

    rows.push({
      rowNumber: FIRST_DATA_ROW + index,
      packageName,
      appName: cell(columns, 1),
      developer: cell(columns, 2),
      status: normaliseStatus(cell(columns, 3), packageName),
      firstLive: cell(columns, 4),
      lastRemoved: cell(columns, 5),
      lastChange: cell(columns, 6),
      pendingFlip: cell(columns, 7),
    });
  });

  return { rows, duplicates };
}

/** Serializes a Row into the seven values for columns B through H. */
export function rowToCells(row) {
  return [
    row.appName,
    row.developer,
    row.status,
    row.firstLive,
    row.lastRemoved,
    row.lastChange,
    row.pendingFlip,
  ];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/rows.test.js`
Expected: PASS, 12 tests.

- [ ] **Step 5: Run the full suite and commit**

Run: `npm test`
Expected: PASS, 33 tests, 0 failures.

```bash
git add src/rows.js tests/rows.test.js
git commit -m "feat: parse, validate and serialize sheet rows"
```

---

### Task 4: Transition decisions and developer count sequencing

**Files:**
- Create: `src/transitions.js`
- Test: `tests/transitions.test.js`

**Interfaces:**
- Consumes: `EXISTS`, `GONE`, `UNKNOWN` from `src/classify.js`.
- Produces:
  - `decide({ status, result, pendingFlip }) => { action: 'none'|'clear'|'mark'|'flip', to?: 'live'|'removed' }`.
  - `sequenceCounts({ rows, flips, details, canaryPackage }) => Event[]` where `Event` is `{ type: 'added'|'removed', packageName, appName, developer, countBefore, countAfter }`. `flips` is `[{ packageName, to }]` and `details` is a `Map<string, { appName, developer }>` supplying values for flips to `live`.

- [ ] **Step 1: Write the failing transitions test**

Create `tests/transitions.test.js`:

```js
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

test('a pending app seen once is only marked, not flipped', () => {
  assert.deepEqual(decide({ status: 'pending', result: EXISTS, pendingFlip: '' }), {
    action: 'mark',
    to: 'live',
  });
});

test('a pending app seen twice flips to live', () => {
  assert.deepEqual(decide({ status: 'pending', result: EXISTS, pendingFlip: 'live' }), {
    action: 'flip',
    to: 'live',
  });
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

test('a removed app returning twice flips back to live', () => {
  assert.deepEqual(decide({ status: 'removed', result: EXISTS, pendingFlip: '' }), {
    action: 'mark',
    to: 'live',
  });
  assert.deepEqual(decide({ status: 'removed', result: EXISTS, pendingFlip: 'live' }), {
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/transitions.test.js`
Expected: FAIL, cannot find module `../src/transitions.js`.

- [ ] **Step 3: Implement `src/transitions.js`**

```js
import { EXISTS, UNKNOWN } from './classify.js';

const UNKNOWN_DEVELOPER = 'Unknown';

/**
 * Decides what a single row should do given one check result.
 *
 * A state change is applied only when the same observation has been seen on two
 * consecutive runs. The first observation is recorded in the row's pendingFlip
 * marker; the second confirms it.
 */
export function decide({ status, result, pendingFlip }) {
  if (result === UNKNOWN) return { action: 'none' };

  const desired = result === EXISTS ? 'live' : 'removed';

  // An app that has never been live and is still absent is simply not
  // published yet. That is not a removal and must never alert.
  if (status === 'pending' && desired === 'removed') {
    return pendingFlip ? { action: 'clear' } : { action: 'none' };
  }

  if (status === desired) {
    return pendingFlip ? { action: 'clear' } : { action: 'none' };
  }

  if (pendingFlip === desired) return { action: 'flip', to: desired };

  return { action: 'mark', to: desired };
}

/**
 * Turns confirmed flips into alert events, attaching each developer's live app
 * count before and after. Flips are processed in order so that several changes
 * for one developer in a single run read 12 to 13, then 13 to 14.
 */
export function sequenceCounts({ rows, flips, details, canaryPackage }) {
  const byPackage = new Map(rows.map((row) => [row.packageName, row]));

  const liveCounts = new Map();
  for (const row of rows) {
    if (row.packageName === canaryPackage) continue;
    if (row.status !== 'live') continue;
    const developer = row.developer || UNKNOWN_DEVELOPER;
    liveCounts.set(developer, (liveCounts.get(developer) ?? 0) + 1);
  }

  const events = [];

  for (const flip of flips) {
    if (flip.packageName === canaryPackage) continue;

    const row = byPackage.get(flip.packageName);
    if (!row) continue;

    let developer;
    let appName;

    if (flip.to === 'live') {
      const detail = details.get(flip.packageName);
      // Without a verified app page there is nothing trustworthy to report.
      if (!detail) continue;
      developer = detail.developer || UNKNOWN_DEVELOPER;
      appName = detail.appName;
    } else {
      developer = row.developer || UNKNOWN_DEVELOPER;
      appName = row.appName;
    }

    const countBefore = liveCounts.get(developer) ?? 0;
    const countAfter = flip.to === 'live' ? countBefore + 1 : Math.max(0, countBefore - 1);
    liveCounts.set(developer, countAfter);

    events.push({
      type: flip.to === 'live' ? 'added' : 'removed',
      packageName: flip.packageName,
      appName,
      developer,
      countBefore,
      countAfter,
    });
  }

  return events;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/transitions.test.js`
Expected: PASS, 18 tests.

- [ ] **Step 5: Run the full suite and commit**

Run: `npm test`
Expected: PASS, 51 tests, 0 failures.

```bash
git add src/transitions.js tests/transitions.test.js
git commit -m "feat: add two-run confirmation state machine and developer count sequencing"
```

---

### Task 5: WhatsApp message construction and parameter sanitization

**Files:**
- Create: `src/messages.js`
- Test: `tests/messages.test.js`

**Interfaces:**
- Consumes: `formatIstTime` from `src/time.js`; `Event` objects from `src/transitions.js`.
- Produces:
  - `sanitizeParam(value: unknown) => string`.
  - `buildMessage({ event, now, templateAdded, templateRemoved }) => { templateName: string, params: string[] }` with params ordered developer, count before, count after, app name, package name, IST time.

- [ ] **Step 1: Write the failing messages test**

Create `tests/messages.test.js`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/messages.test.js`
Expected: FAIL, cannot find module `../src/messages.js`.

- [ ] **Step 3: Implement `src/messages.js`**

```js
import { formatIstTime } from './time.js';

/**
 * Meta rejects template parameters containing newlines, tabs, runs of four or
 * more spaces, or the characters # $ %. Keep values short so the rendered body
 * stays inside the 1024 character template limit.
 */
const MAX_PARAM_LENGTH = 60;

export function sanitizeParam(value) {
  if (value === null || value === undefined) return '-';

  let text = String(value)
    .replace(/[#$%]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length > MAX_PARAM_LENGTH) {
    text = `${text.slice(0, MAX_PARAM_LENGTH - 3).trimEnd()}...`;
  }

  // Meta also rejects empty parameter values.
  return text || '-';
}

/**
 * Builds the template name and ordered parameters for one event.
 * Parameter order matches both approved templates:
 * developer, count before, count after, app name, package name, IST time.
 */
export function buildMessage({ event, now, templateAdded, templateRemoved }) {
  const templateName = event.type === 'added' ? templateAdded : templateRemoved;

  return {
    templateName,
    params: [
      sanitizeParam(event.developer),
      sanitizeParam(event.countBefore),
      sanitizeParam(event.countAfter),
      sanitizeParam(event.appName || event.packageName),
      sanitizeParam(event.packageName),
      sanitizeParam(formatIstTime(now)),
    ],
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/messages.test.js`
Expected: PASS, 10 tests.

Note: `sanitizeParam('  spaced  ')` returns `spaced`, and `sanitizeParam(12)` returns `'12'`. If the truncation test fails by one character, check that the slice leaves room for the three dots.

- [ ] **Step 5: Run the full suite and commit**

Run: `npm test`
Expected: PASS, 61 tests, 0 failures.

```bash
git add src/messages.js tests/messages.test.js
git commit -m "feat: build WhatsApp template messages with Meta-safe parameter sanitization"
```

---

### Task 6: Play Store client

**Files:**
- Create: `src/playstore.js`
- Test: `tests/playstore.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `storeUrl(packageName: string, region: string) => string`.
  - `parseDetails(html: string) => { appName: string, developer: string } | null`, returning `null` for anything that is not a genuine app page.
  - `checkStatus(packageName, { region, fetchImpl, timeoutMs }) => Promise<number|null>` resolving to the HTTP status or `null` on a network failure.
  - `fetchDetails(packageName, { region, fetchImpl, timeoutMs }) => Promise<{ appName, developer } | null>`.
  - `checkAll(packageNames: string[], { region, concurrency, fetchImpl }) => Promise<Map<string, number|null>>`.

- [ ] **Step 1: Write the failing playstore test**

Create `tests/playstore.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storeUrl, parseDetails, checkStatus, fetchDetails, checkAll } from '../src/playstore.js';

test('builds the store URL with region and language pinned', () => {
  const url = storeUrl('com.vasu.app', 'US');
  assert.ok(url.startsWith('https://play.google.com/store/apps/details?'));
  assert.ok(url.includes('id=com.vasu.app'));
  assert.ok(url.includes('gl=US'));
  assert.ok(url.includes('hl=en'));
});

test('URL-encodes the package name', () => {
  assert.ok(storeUrl('com.vasu app', 'US').includes('id=com.vasu%20app'));
});

const APP_PAGE = `
<html><head>
<meta property="og:title" content="Vasu App Name - Apps on Google Play">
</head><body>
<a href="/store/apps/dev?id=123456789"><span>VASU COMPANY LLC</span></a>
</body></html>`;

test('extracts app name and developer from a real app page', () => {
  assert.deepEqual(parseDetails(APP_PAGE), {
    appName: 'Vasu App Name',
    developer: 'VASU COMPANY LLC',
  });
});

test('supports the /store/apps/developer link form', () => {
  const html = APP_PAGE.replace('/store/apps/dev?id=123456789', '/store/apps/developer?id=Vasu+Company');
  assert.equal(parseDetails(html).developer, 'VASU COMPANY LLC');
});

test('decodes HTML entities in the app name', () => {
  const html = APP_PAGE.replace('Vasu App Name', 'Tom &amp; Jerry&#39;s Game');
  assert.equal(parseDetails(html).appName, "Tom & Jerry's Game");
});

test('rejects a consent or captcha page that lacks an app title', () => {
  assert.equal(parseDetails('<html><body>Before you continue to Google</body></html>'), null);
});

test('rejects a page whose title is not a Google Play app title', () => {
  const html = '<meta property="og:title" content="Google Play">';
  assert.equal(parseDetails(html), null);
});

test('rejects an app page with no developer link', () => {
  const html = '<meta property="og:title" content="Vasu App Name - Apps on Google Play">';
  assert.equal(parseDetails(html), null);
});

test('checkStatus returns the HTTP status code', async () => {
  const fetchImpl = async () => ({ status: 404, body: null });
  assert.equal(await checkStatus('com.vasu.app', { region: 'US', fetchImpl }), 404);
});

test('checkStatus returns null when the request throws', async () => {
  const fetchImpl = async () => {
    throw new Error('ECONNRESET');
  };
  assert.equal(await checkStatus('com.vasu.app', { region: 'US', fetchImpl }), null);
});

test('checkStatus sends a browser-like User-Agent', async () => {
  let seen = null;
  const fetchImpl = async (_url, options) => {
    seen = options.headers['User-Agent'];
    return { status: 200, body: null };
  };
  await checkStatus('com.vasu.app', { region: 'US', fetchImpl });
  assert.match(seen, /Mozilla/);
});

test('checkStatus discards the response body without reading it', async () => {
  let cancelled = false;
  const fetchImpl = async () => ({
    status: 200,
    body: {
      cancel: async () => {
        cancelled = true;
      },
    },
  });
  await checkStatus('com.vasu.app', { region: 'US', fetchImpl });
  assert.equal(cancelled, true);
});

test('fetchDetails returns parsed details for a 200 app page', async () => {
  const fetchImpl = async () => ({ status: 200, text: async () => APP_PAGE });
  const details = await fetchDetails('com.vasu.app', { region: 'US', fetchImpl });
  assert.equal(details.developer, 'VASU COMPANY LLC');
});

test('fetchDetails returns null for a non-200 response', async () => {
  const fetchImpl = async () => ({ status: 429, text: async () => '' });
  assert.equal(await fetchDetails('com.vasu.app', { region: 'US', fetchImpl }), null);
});

test('fetchDetails returns null when the request throws', async () => {
  const fetchImpl = async () => {
    throw new Error('timeout');
  };
  assert.equal(await fetchDetails('com.vasu.app', { region: 'US', fetchImpl }), null);
});

test('checkAll returns a status for every package', async () => {
  const fetchImpl = async (url) => ({ status: url.includes('gone') ? 404 : 200, body: null });
  const results = await checkAll(['com.vasu.live', 'com.vasu.gone'], {
    region: 'US',
    concurrency: 2,
    fetchImpl,
  });
  assert.equal(results.get('com.vasu.live'), 200);
  assert.equal(results.get('com.vasu.gone'), 404);
});

test('checkAll never exceeds the configured concurrency', async () => {
  let inFlight = 0;
  let peak = 0;
  const fetchImpl = async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return { status: 200, body: null };
  };
  const packages = Array.from({ length: 20 }, (_, index) => `com.vasu.app${index}`);
  await checkAll(packages, { region: 'US', concurrency: 3, fetchImpl });
  assert.ok(peak <= 3, `peak concurrency was ${peak}`);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/playstore.test.js`
Expected: FAIL, cannot find module `../src/playstore.js`.

- [ ] **Step 3: Implement `src/playstore.js`**

```js
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const DEFAULT_TIMEOUT_MS = 10000;

export function storeUrl(packageName, region) {
  const params = new URLSearchParams({ id: packageName, hl: 'en', gl: region });
  return `https://play.google.com/store/apps/details?${params.toString()}`;
}

function decodeEntities(text) {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Extracts the app name and developer from a store page.
 * Returns null for anything that is not a genuine app page, which covers
 * consent walls, captchas and interstitials. Recording a guess would poison the
 * sheet, so an unrecognised page abandons the flip and retries next run.
 */
export function parseDetails(html) {
  if (typeof html !== 'string' || html.length === 0) return null;

  const titleMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
  if (!titleMatch) return null;

  const rawTitle = decodeEntities(titleMatch[1]).trim();
  const appName = rawTitle.replace(/\s*-\s*Apps on Google Play\s*$/i, '').trim();
  if (!appName || appName === rawTitle) return null;

  const devMatch = html.match(
    /<a[^>]+href="\/store\/apps\/dev(?:eloper)?\?id=[^"]*"[^>]*>(?:\s*<[^>]+>\s*)*([^<]+)/i,
  );
  if (!devMatch) return null;

  const developer = decodeEntities(devMatch[1]).trim();
  if (!developer) return null;

  return { appName, developer };
}

async function request(url, { fetchImpl, timeoutMs, method = 'GET' }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      method,
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads only the HTTP status code for one package and discards the body.
 * Returns null on any network failure, which the caller classifies as unknown.
 */
export async function checkStatus(
  packageName,
  { region, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) {
  try {
    const response = await request(storeUrl(packageName, region), { fetchImpl, timeoutMs });
    // Avoid downloading roughly a megabyte of HTML we do not need.
    if (response.body && typeof response.body.cancel === 'function') {
      await response.body.cancel().catch(() => {});
    }
    return response.status;
  } catch {
    return null;
  }
}

/** Fetches and parses one full app page. Only called on a confirmed flip to live. */
export async function fetchDetails(
  packageName,
  { region, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) {
  try {
    const response = await request(storeUrl(packageName, region), { fetchImpl, timeoutMs });
    if (response.status !== 200) return null;
    return parseDetails(await response.text());
  } catch {
    return null;
  }
}

/** Checks every package with a bounded number of requests in flight. */
export async function checkAll(
  packageNames,
  { region, concurrency = 20, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) {
  const results = new Map();
  const queue = [...packageNames];

  async function worker() {
    while (queue.length > 0) {
      const packageName = queue.shift();
      results.set(packageName, await checkStatus(packageName, { region, fetchImpl, timeoutMs }));
    }
  }

  // Note the arrow function: `Array.from({length: n}, worker)` would pass the
  // array index to worker as its first argument, which is not what we want.
  const workerCount = Math.min(concurrency, queue.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/playstore.test.js`
Expected: PASS, 17 tests.

- [ ] **Step 5: Verify the parsing regexes against a live page**

The two regexes in `parseDetails` are the most fragile part of the system, because they depend on Google's HTML. Confirm them against reality before trusting them.

Run:

```bash
node -e "
import('./src/playstore.js').then(async (m) => {
  const html = await fetch(m.storeUrl('com.whatsapp', 'US'), {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  }).then((r) => r.text());
  console.log(m.parseDetails(html));
});
"
```

Expected: an object with `appName` of `WhatsApp Messenger` and a non-empty `developer`.

If it prints `null`, inspect the live HTML and adjust the regexes, then update the fixture in `tests/playstore.test.js` to match the real markup. Do not move on until this prints real values.

- [ ] **Step 6: Verify a missing listing really returns 404**

Run:

```bash
node -e "
import('./src/playstore.js').then(async (m) => {
  console.log('missing:', await m.checkStatus('com.canary.doesnotexist.monitor', { region: 'US' }));
  console.log('present:', await m.checkStatus('com.whatsapp', { region: 'US' }));
});
"
```

Expected: `missing: 404` and `present: 200`. The whole design rests on this.

Two ways this can come back wrong, both of which must be resolved before moving on:

- **`present: 200` but `missing: 200`.** Play Store has stopped returning 404 for
  absent listings. Detection cannot work as specified. Stop and report it.
- **Either value is a 3xx such as 301 or 302.** `checkStatus` uses
  `redirect: 'manual'` so a redirect surfaces rather than being silently
  followed into a consent page. If real listings redirect, switch that option to
  `redirect: 'follow'` and re-run this check. Do not simply treat 3xx as
  existing, because a consent wall also answers 200.

- [ ] **Step 7: Run the full suite and commit**

Run: `npm test`
Expected: PASS, 78 tests, 0 failures.

```bash
git add src/playstore.js tests/playstore.test.js
git commit -m "feat: add Play Store status checking and app page parsing"
```

---

### Task 7: Google Sheets client

**Files:**
- Create: `src/sheets.js`
- Test: `tests/sheets.test.js`

**Interfaces:**
- Consumes: `rowToCells` from `src/rows.js`.
- Produces:
  - `buildUpdateData({ sheetTab, rows, lastRunAt }) => Array<{ range: string, values: string[][] }>`.
  - `createSheetsClient({ serviceAccount, sheetId, sheetTab, fetchImpl, authFactory }) => { readRows(): Promise<string[][]>, writeChanges({ rows, lastRunAt }): Promise<void> }`.

- [ ] **Step 1: Write the failing sheets test**

Create `tests/sheets.test.js`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/sheets.test.js`
Expected: FAIL, cannot find module `../src/sheets.js`.

- [ ] **Step 3: Implement `src/sheets.js`**

```js
import { JWT } from 'google-auth-library';
import { rowToCells } from './rows.js';

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const API_ROOT = 'https://sheets.googleapis.com/v4/spreadsheets';

/** The cell that records when the monitor last ran, so the sheet shows liveness. */
const LAST_RUN_CELL = 'J2';

function defaultAuthFactory(serviceAccount) {
  return new JWT({
    email: serviceAccount.client_email,
    key: serviceAccount.private_key,
    scopes: [SCOPE],
  });
}

/**
 * Builds one ranged update per changed row, plus the heartbeat cell.
 * Only rows that actually changed are written, which keeps a run to two API
 * calls regardless of how many apps are being tracked.
 */
export function buildUpdateData({ sheetTab, rows, lastRunAt }) {
  const data = rows.map((row) => ({
    range: `'${sheetTab}'!B${row.rowNumber}:H${row.rowNumber}`,
    values: [rowToCells(row)],
  }));

  data.push({ range: `'${sheetTab}'!${LAST_RUN_CELL}`, values: [[lastRunAt]] });

  return data;
}

export function createSheetsClient({
  serviceAccount,
  sheetId,
  sheetTab,
  fetchImpl = fetch,
  authFactory = defaultAuthFactory,
}) {
  const auth = authFactory(serviceAccount);
  let cachedToken = null;

  async function token() {
    if (cachedToken) return cachedToken;
    const result = await auth.getAccessToken();
    cachedToken = typeof result === 'string' ? result : result?.token;
    if (!cachedToken) throw new Error('Google authentication returned no access token');
    return cachedToken;
  }

  async function call(url, options = {}) {
    const response = await fetchImpl(url, {
      ...options,
      headers: {
        ...options.headers,
        Authorization: `Bearer ${await token()}`,
        'Content-Type': 'application/json',
      },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Google Sheets API error ${response.status}: ${body.slice(0, 200)}`);
    }
    return response.json();
  }

  return {
    async readRows() {
      const range = encodeURIComponent(`'${sheetTab}'!A2:H`);
      const payload = await call(`${API_ROOT}/${sheetId}/values/${range}`);
      return payload.values ?? [];
    },

    async writeChanges({ rows, lastRunAt }) {
      await call(`${API_ROOT}/${sheetId}/values:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({
          valueInputOption: 'RAW',
          data: buildUpdateData({ sheetTab, rows, lastRunAt }),
        }),
      });
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/sheets.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 5: Run the full suite and commit**

Run: `npm test`
Expected: PASS, 86 tests, 0 failures.

```bash
git add src/sheets.js tests/sheets.test.js
git commit -m "feat: add Google Sheets read and batched write client"
```

---

### Task 8: WhatsApp Cloud API client

**Files:**
- Create: `src/whatsapp.js`
- Test: `tests/whatsapp.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `buildTemplatePayload({ to, templateName, templateLanguage, params }) => object`.
  - `createWhatsAppClient({ token, phoneNumberId, apiVersion, templateLanguage, fetchImpl }) => { sendTemplate({ to, templateName, params }): Promise<{ ok: boolean, error: string|null }> }`.

- [ ] **Step 1: Write the failing whatsapp test**

Create `tests/whatsapp.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTemplatePayload, createWhatsAppClient } from '../src/whatsapp.js';

test('builds the Cloud API template payload', () => {
  const payload = buildTemplatePayload({
    to: '919876543210',
    templateName: 'play_store_app_added',
    templateLanguage: 'en',
    params: ['VASU COMPANY LLC', '12', '13', 'Vasu App Name', 'com.vasu.app', '2:51 PM'],
  });

  assert.deepEqual(payload, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: '919876543210',
    type: 'template',
    template: {
      name: 'play_store_app_added',
      language: { code: 'en' },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: 'VASU COMPANY LLC' },
            { type: 'text', text: '12' },
            { type: 'text', text: '13' },
            { type: 'text', text: 'Vasu App Name' },
            { type: 'text', text: 'com.vasu.app' },
            { type: 'text', text: '2:51 PM' },
          ],
        },
      ],
    },
  });
});

const clientOptions = {
  token: 'token-abc',
  phoneNumberId: '999888777',
  apiVersion: 'v21.0',
  templateLanguage: 'en',
};

test('posts to the messages endpoint with a bearer token', async () => {
  let seenUrl = null;
  let seenAuth = null;
  const fetchImpl = async (url, options) => {
    seenUrl = url;
    seenAuth = options.headers.Authorization;
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.1' }] }) };
  };
  const client = createWhatsAppClient({ ...clientOptions, fetchImpl });
  const result = await client.sendTemplate({
    to: '919876543210',
    templateName: 'play_store_app_added',
    params: ['a', '1', '2', 'b', 'c', 'd'],
  });

  assert.deepEqual(result, { ok: true, error: null });
  assert.equal(seenUrl, 'https://graph.facebook.com/v21.0/999888777/messages');
  assert.equal(seenAuth, 'Bearer token-abc');
});

test('reports a failure without throwing', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 400,
    text: async () => '{"error":{"message":"Template name does not exist"}}',
  });
  const client = createWhatsAppClient({ ...clientOptions, fetchImpl });
  const result = await client.sendTemplate({
    to: '919876543210',
    templateName: 'missing_template',
    params: [],
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /400/);
  assert.match(result.error, /Template name does not exist/);
});

test('reports a network failure without throwing', async () => {
  const fetchImpl = async () => {
    throw new Error('ECONNRESET');
  };
  const client = createWhatsAppClient({ ...clientOptions, fetchImpl });
  const result = await client.sendTemplate({ to: '9198', templateName: 't', params: [] });
  assert.equal(result.ok, false);
  assert.match(result.error, /ECONNRESET/);
});

test('never puts the access token in the returned error text', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => 'token-abc is invalid' });
  const client = createWhatsAppClient({ ...clientOptions, fetchImpl });
  const result = await client.sendTemplate({ to: '9198', templateName: 't', params: [] });
  assert.doesNotMatch(result.error, /token-abc/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/whatsapp.test.js`
Expected: FAIL, cannot find module `../src/whatsapp.js`.

- [ ] **Step 3: Implement `src/whatsapp.js`**

```js
export function buildTemplatePayload({ to, templateName, templateLanguage, params }) {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: templateLanguage },
      components: [
        {
          type: 'body',
          parameters: params.map((text) => ({ type: 'text', text })),
        },
      ],
    },
  };
}

export function createWhatsAppClient({
  token,
  phoneNumberId,
  apiVersion,
  templateLanguage,
  fetchImpl = fetch,
}) {
  const endpoint = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;

  /** Redacts the access token so it can never reach a public Actions log. */
  const redact = (text) => String(text).split(token).join('[redacted]');

  return {
    async sendTemplate({ to, templateName, params }) {
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(
            buildTemplatePayload({ to, templateName, templateLanguage, params }),
          ),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          return { ok: false, error: redact(`HTTP ${response.status}: ${body.slice(0, 300)}`) };
        }

        await response.json().catch(() => ({}));
        return { ok: true, error: null };
      } catch (error) {
        return { ok: false, error: redact(error.message ?? String(error)) };
      }
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/whatsapp.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Run the full suite and commit**

Run: `npm test`
Expected: PASS, 91 tests, 0 failures.

```bash
git add src/whatsapp.js tests/whatsapp.test.js
git commit -m "feat: add Meta WhatsApp Cloud API template sender"
```

---

### Task 9: Run orchestration

**Files:**
- Create: `src/run.js`
- Create: `src/index.js`
- Test: `tests/run.test.js`

**Interfaces:**
- Consumes: everything built so far.
- Produces:
  - `runOnce({ config, sheets, whatsapp, playstore, logger, now }) => Promise<{ exitCode: number, summary: object }>` where `summary` is `{ tracked, exists, gone, unknown, invalid, duplicates, marked, flipped, sent, sendFailures, canaryBroken }`. `playstore` is an object exposing `checkAll` and `fetchDetails` so the orchestration is testable without a network.

- [ ] **Step 1: Write the failing run test**

Create `tests/run.test.js`:

```js
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

test('a first sighting only marks the row and sends nothing', async () => {
  const s = stubs({
    values: [['com.vasu.app', '', '', 'pending', '', '', '', '']],
    statuses: { 'com.vasu.app': 200 },
  });
  const result = await runOnce({ config: baseConfig(), ...s, now });

  assert.equal(s.sent.length, 0);
  assert.equal(result.summary.marked, 1);
  assert.equal(result.summary.flipped, 0);
  assert.equal(s.written[0].rows[0].pendingFlip, 'live');
  assert.equal(s.written[0].rows[0].status, 'pending');
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/run.test.js`
Expected: FAIL, cannot find module `../src/run.js`.

- [ ] **Step 3: Implement `src/run.js`**

```js
import { classify, EXISTS, GONE, UNKNOWN } from './classify.js';
import { parseRows } from './rows.js';
import { decide, sequenceCounts } from './transitions.js';
import { buildMessage } from './messages.js';
import { formatIstDateTime } from './time.js';

/** A run where most checks are inconclusive is a broken run, not a quiet one. */
const UNKNOWN_FAILURE_RATIO = 0.5;

export async function runOnce({ config, sheets, whatsapp, playstore, logger, now = new Date() }) {
  const stamp = formatIstDateTime(now);

  const values = await sheets.readRows();
  const { rows, duplicates } = parseRows(values);

  const checkable = rows.filter((row) => row.status !== 'invalid');
  const results = await playstore.checkAll(
    checkable.map((row) => row.packageName),
    { region: config.playRegion, concurrency: config.concurrency },
  );

  const counts = { [EXISTS]: 0, [GONE]: 0, [UNKNOWN]: 0 };
  const changedRows = new Map();
  const flips = [];
  let canaryBroken = false;

  // Invalid rows are never requested, but the sheet should still say so.
  // Only write one if the sheet does not already record it, so a malformed
  // package name is not rewritten on every single run.
  for (const row of rows) {
    if (row.status !== 'invalid') continue;
    const recordedStatus = (values[row.rowNumber - 2]?.[3] ?? '').trim().toLowerCase();
    if (recordedStatus !== 'invalid' || row.pendingFlip !== '') {
      changedRows.set(row.packageName, { ...row, status: 'invalid', pendingFlip: '' });
    }
  }

  for (const row of checkable) {
    const result = classify(results.get(row.packageName) ?? null);
    counts[result] += 1;

    if (row.packageName === config.canaryPackage) {
      if (result === EXISTS) canaryBroken = true;
      continue;
    }

    const decision = decide({ status: row.status, result, pendingFlip: row.pendingFlip });

    if (decision.action === 'mark') {
      changedRows.set(row.packageName, { ...row, pendingFlip: decision.to });
    } else if (decision.action === 'clear') {
      changedRows.set(row.packageName, { ...row, pendingFlip: '' });
    } else if (decision.action === 'flip') {
      flips.push({ packageName: row.packageName, to: decision.to });
    }
  }

  const marked = [...changedRows.values()].filter((row) => row.pendingFlip !== '').length;

  // Only a confirmed flip to live justifies downloading a full page.
  const details = new Map();
  for (const flip of flips) {
    if (flip.to !== 'live') continue;
    const detail = await playstore.fetchDetails(flip.packageName, { region: config.playRegion });
    if (detail) {
      details.set(flip.packageName, detail);
    } else {
      logger.detail(`could not parse app page for ${flip.packageName}, retrying next run`);
    }
  }

  const events = sequenceCounts({
    rows,
    flips,
    details,
    canaryPackage: config.canaryPackage,
  });

  const byPackage = new Map(rows.map((row) => [row.packageName, row]));
  let sent = 0;
  let sendFailures = 0;

  for (const event of events) {
    const message = buildMessage({
      event,
      now,
      templateAdded: config.templateAdded,
      templateRemoved: config.templateRemoved,
    });

    logger.detail(
      `${event.type}: ${event.appName} (${event.packageName}) under ${event.developer} ` +
        `${event.countBefore} -> ${event.countAfter}`,
    );

    let delivered = true;
    if (!config.dryRun) {
      for (const to of config.recipients) {
        const outcome = await whatsapp.sendTemplate({
          to,
          templateName: message.templateName,
          params: message.params,
        });
        if (outcome.ok) {
          sent += 1;
        } else {
          delivered = false;
          sendFailures += 1;
          logger.error(`WhatsApp send failed: ${outcome.error}`);
        }
      }
    }

    // A flip is persisted only once every recipient has it. If delivery failed,
    // the row stays as it was so the next run re-detects and retries. A repeat
    // message is acceptable; a lost one is not.
    if (!delivered) continue;

    const row = byPackage.get(event.packageName);
    const updated = {
      ...row,
      appName: event.appName,
      developer: event.developer,
      status: event.type === 'added' ? 'live' : 'removed',
      lastChange: stamp,
      pendingFlip: '',
    };
    if (event.type === 'added' && !row.firstLive) updated.firstLive = stamp;
    if (event.type === 'removed') updated.lastRemoved = stamp;

    changedRows.set(event.packageName, updated);
  }

  const flipped = events.length;
  const tracked = rows.length;
  const totalChecked = counts[EXISTS] + counts[GONE] + counts[UNKNOWN];
  const mostlyUnknown =
    totalChecked > 0 && counts[UNKNOWN] / totalChecked > UNKNOWN_FAILURE_RATIO;

  if (!config.dryRun) {
    await sheets.writeChanges({ rows: [...changedRows.values()], lastRunAt: stamp });
  }

  const summary = {
    tracked,
    exists: counts[EXISTS],
    gone: counts[GONE],
    unknown: counts[UNKNOWN],
    invalid: rows.length - checkable.length,
    duplicates,
    marked,
    flipped,
    sent,
    sendFailures,
    canaryBroken,
  };

  logger.info(
    `tracked ${summary.tracked} · live ${summary.exists} · gone ${summary.gone} · ` +
      `unknown ${summary.unknown} · invalid ${summary.invalid} · marked ${summary.marked} · ` +
      `changed ${summary.flipped} · messages ${summary.sent}`,
  );

  if (canaryBroken) {
    logger.error('canary listing resolved as live; removal detection may be broken');
  }
  if (mostlyUnknown) {
    logger.error('more than half of all checks were inconclusive; likely throttled');
  }

  const exitCode = canaryBroken || mostlyUnknown || sendFailures > 0 ? 1 : 0;
  return { exitCode, summary };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/run.test.js`
Expected: PASS, 13 tests.

- [ ] **Step 5: Implement `src/index.js`**

```js
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createSheetsClient } from './sheets.js';
import { createWhatsAppClient } from './whatsapp.js';
import { checkAll, fetchDetails } from './playstore.js';
import { runOnce } from './run.js';

async function main() {
  const config = loadConfig(process.env);
  const logger = createLogger({ verbose: config.dryRun });

  if (config.dryRun) {
    logger.info('DRY RUN: no messages will be sent and the sheet will not be written');
  }

  const sheets = createSheetsClient({
    serviceAccount: config.serviceAccount,
    sheetId: config.sheetId,
    sheetTab: config.sheetTab,
  });

  const whatsapp = config.dryRun
    ? { sendTemplate: async () => ({ ok: true, error: null }) }
    : createWhatsAppClient({
        token: config.metaToken,
        phoneNumberId: config.metaPhoneNumberId,
        apiVersion: config.metaApiVersion,
        templateLanguage: config.templateLanguage,
      });

  const { exitCode } = await runOnce({
    config,
    sheets,
    whatsapp,
    playstore: { checkAll, fetchDetails },
    logger,
    now: new Date(),
  });

  process.exitCode = exitCode;
}

main().catch((error) => {
  // Never print the error object wholesale; it can contain request bodies.
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
});
```

- [ ] **Step 6: Run the full suite and commit**

Run: `npm test`
Expected: PASS, 104 tests, 0 failures.

```bash
git add src/run.js src/index.js tests/run.test.js
git commit -m "feat: orchestrate a monitoring run end to end"
```

---

### Task 10: GitHub Actions workflows and README

**Files:**
- Create: `.github/workflows/monitor.yml`
- Create: `.github/workflows/heartbeat.yml`
- Create: `README.md`

**Interfaces:**
- Consumes: `src/index.js` and the secrets documented in `docs/setup-guide.md`.
- Produces: nothing consumed by other tasks.

- [ ] **Step 1: Create `.github/workflows/monitor.yml`**

```yaml
name: monitor

on:
  schedule:
    # Every 10 minutes. GitHub may delay or drop runs under load.
    - cron: '*/10 * * * *'
  workflow_dispatch:

permissions:
  contents: read

# Never let two runs overlap; both would write the same sheet rows.
concurrency:
  group: monitor
  cancel-in-progress: false

jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'

      - run: npm ci

      - name: Check listings
        run: node src/index.js
        env:
          SHEET_ID: ${{ secrets.SHEET_ID }}
          GOOGLE_SERVICE_ACCOUNT_JSON: ${{ secrets.GOOGLE_SERVICE_ACCOUNT_JSON }}
          META_ACCESS_TOKEN: ${{ secrets.META_ACCESS_TOKEN }}
          META_PHONE_NUMBER_ID: ${{ secrets.META_PHONE_NUMBER_ID }}
          WHATSAPP_RECIPIENTS: ${{ secrets.WHATSAPP_RECIPIENTS }}
          PLAY_REGION: ${{ vars.PLAY_REGION }}
          CONCURRENCY: ${{ vars.CONCURRENCY }}
          SHEET_TAB: ${{ vars.SHEET_TAB }}
```

- [ ] **Step 2: Create `.github/workflows/heartbeat.yml`**

```yaml
name: heartbeat

# GitHub disables scheduled workflows in a repository with no activity for 60
# days. A weekly commit keeps the monitor's schedule alive.
on:
  schedule:
    - cron: '17 3 * * 1'
  workflow_dispatch:

permissions:
  contents: write

jobs:
  touch:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Record a heartbeat
        run: |
          date -u +"%Y-%m-%dT%H:%M:%SZ" > .heartbeat
          git config user.name "play-store-monitor"
          git config user.email "play-store-monitor@users.noreply.github.com"
          git add .heartbeat
          git diff --staged --quiet && exit 0
          git commit -m "chore: heartbeat"
          git push
```

- [ ] **Step 3: Validate the workflow YAML parses**

Run:

```bash
node -e "
const fs = require('fs');
for (const f of ['.github/workflows/monitor.yml', '.github/workflows/heartbeat.yml']) {
  const text = fs.readFileSync(f, 'utf8');
  if (!text.includes('runs-on: ubuntu-latest')) throw new Error('missing runner in ' + f);
  console.log(f, 'looks structurally sane');
}
"
```

Expected: both files print `looks structurally sane`.

- [ ] **Step 4: Create `README.md`**

```markdown
# Play Store Listing Monitor

Watches a list of Google Play packages and sends a WhatsApp message when a
listing appears or disappears.

- **Design:** [`docs/superpowers/specs/2026-09-03-play-store-monitor-design.md`](docs/superpowers/specs/2026-09-03-play-store-monitor-design.md)
- **One-time setup:** [`docs/setup-guide.md`](docs/setup-guide.md)

## How it works

A GitHub Actions cron runs every 10 minutes. For each package it requests the
store page and looks only at the HTTP status code: `200` means the listing
exists, `404` means it is gone, anything else is inconclusive and retried. A
change must be seen on two consecutive runs before it is applied, so a transient
failure never raises a false alarm.

A Google Sheet is the single source of truth. You type package names into column
A; the tool owns columns B through H and writes back only the rows that changed.

## Daily use

Paste new package names into column A of the sheet. Nothing else.

## Running locally

```bash
npm ci
npm test

# Dry run: reads the sheet and checks listings, but writes nothing and sends
# nothing. This is the only mode that prints package and app names.
DRY_RUN=true \
SHEET_ID=... \
GOOGLE_SERVICE_ACCOUNT_JSON="$(cat service-account.json)" \
node src/index.js
```

## Privacy note

This repository is public so that Actions minutes are free. Nothing sensitive
lives here: the package list is in the Google Sheet and all credentials are in
encrypted repository secrets. **Workflow logs are world-readable, so the script
prints counts only and never package names, app names or developer accounts.**

## Exit codes

The run exits non-zero, which makes GitHub email the repository owner, when:

- more than half of all checks were inconclusive, which usually means throttling
- a WhatsApp send failed, in which case the change is retried on the next run
- the canary package resolved as live, meaning removal detection is broken
```

- [ ] **Step 5: Run the full suite one final time**

Run: `npm test`
Expected: PASS, 104 tests, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/monitor.yml .github/workflows/heartbeat.yml README.md
git commit -m "feat: add scheduled workflows, heartbeat and README"
```

- [ ] **Step 7: Verify the repository contains nothing sensitive before it is pushed**

Run:

```bash
git grep -nEi "(private_key|BEGIN [A-Z ]*PRIVATE KEY|EAA[A-Za-z0-9]{20,}|[0-9]{12,})" -- . ':!package-lock.json' || echo "clean"
git log --format='%an <%ae>' | sort -u
```

Expected: the first command prints `clean` or only harmless matches in test fixtures and documentation. The second prints only
`play-store-monitor <play-store-monitor@users.noreply.github.com>`. If any personal name or email appears, stop and rewrite the history before pushing.

---

## Post-implementation manual verification

These require the real credentials from `docs/setup-guide.md` and cannot be automated.

1. **Dry run against the real sheet.** Set `DRY_RUN=true` with the real
   `SHEET_ID` and service account, then run `node src/index.js`. It should print
   package names and a summary, write nothing, and send nothing.
2. **First live run.** Trigger the workflow by hand from the Actions tab. The
   sheet should populate columns B through H and cell `J2`. The log should show
   counts and no package names.
3. **End-to-end WhatsApp check.** Add a package known to be live. Trigger the
   workflow twice, a few minutes apart. The first run marks, the second flips
   and both phones receive the ADDED message with correct counts.
4. **Failure path.** Temporarily set the `META_ACCESS_TOKEN` secret to a wrong
   value and trigger a run with a pending change. The run should fail, the row
   should stay unchanged, and restoring the token should let the next run deliver
   the alert.
