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
  assert.equal(config.templateLanguage, 'en_US');
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

test('suppressAlerts defaults to false and reads SUPPRESS_ALERTS', () => {
  assert.equal(loadConfig(baseEnv).suppressAlerts, false);
  assert.equal(loadConfig({ ...baseEnv, SUPPRESS_ALERTS: 'true' }).suppressAlerts, true);
  assert.equal(loadConfig({ ...baseEnv, SUPPRESS_ALERTS: 'TRUE' }).suppressAlerts, true);
  assert.equal(loadConfig({ ...baseEnv, SUPPRESS_ALERTS: 'false' }).suppressAlerts, false);
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
