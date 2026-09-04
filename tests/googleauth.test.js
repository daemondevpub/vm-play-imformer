import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { buildAssertion, createGoogleAuth } from '../src/googleauth.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const serviceAccount = {
  client_email: 'bot@proj.iam.gserviceaccount.com',
  private_key: privateKey,
  token_uri: 'https://oauth2.googleapis.com/token',
};

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const now = new Date('2026-09-04T09:00:00Z');

function decodeSegment(segment) {
  return JSON.parse(Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
}

test('the assertion has three base64url segments and no padding', () => {
  const assertion = buildAssertion({ serviceAccount, scope: SCOPE, now });
  const parts = assertion.split('.');
  assert.equal(parts.length, 3);
  for (const part of parts) {
    assert.doesNotMatch(part, /[+/=]/, 'must be base64url, not standard base64');
  }
});

test('the header declares RS256', () => {
  const [header] = buildAssertion({ serviceAccount, scope: SCOPE, now }).split('.');
  assert.deepEqual(decodeSegment(header), { alg: 'RS256', typ: 'JWT' });
});

test('the claim set matches what Google requires', () => {
  const [, claims] = buildAssertion({ serviceAccount, scope: SCOPE, now }).split('.');
  const decoded = decodeSegment(claims);
  assert.equal(decoded.iss, 'bot@proj.iam.gserviceaccount.com');
  assert.equal(decoded.scope, SCOPE);
  assert.equal(decoded.aud, 'https://oauth2.googleapis.com/token');
  assert.equal(decoded.iat, Math.floor(now.getTime() / 1000));
  assert.equal(decoded.exp, Math.floor(now.getTime() / 1000) + 3600);
});

test('falls back to the standard token endpoint when the key omits token_uri', () => {
  const [, claims] = buildAssertion({
    serviceAccount: { client_email: 'a@b.com', private_key: privateKey },
    scope: SCOPE,
    now,
  }).split('.');
  assert.equal(decodeSegment(claims).aud, 'https://oauth2.googleapis.com/token');
});

test('the signature verifies against the public key', () => {
  const assertion = buildAssertion({ serviceAccount, scope: SCOPE, now });
  const [header, claims, signature] = assertion.split('.');
  const verified = createVerify('RSA-SHA256')
    .update(`${header}.${claims}`)
    .verify(publicKey, Buffer.from(signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
  assert.equal(verified, true);
});

test('exchanges the assertion for an access token', async () => {
  let sentBody = null;
  let sentUrl = null;
  const fetchImpl = async (url, options) => {
    sentUrl = url;
    sentBody = new URLSearchParams(options.body);
    return { ok: true, status: 200, json: async () => ({ access_token: 'ya29.token', expires_in: 3600 }) };
  };

  const auth = createGoogleAuth({ serviceAccount, scope: SCOPE, fetchImpl });
  assert.equal(await auth.getAccessToken(now), 'ya29.token');
  assert.equal(sentUrl, 'https://oauth2.googleapis.com/token');
  assert.equal(sentBody.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  assert.equal(sentBody.get('assertion').split('.').length, 3);
});

test('caches the token instead of re-exchanging on every call', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ access_token: 'ya29.token', expires_in: 3600 }) };
  };
  const auth = createGoogleAuth({ serviceAccount, scope: SCOPE, fetchImpl });
  await auth.getAccessToken(now);
  await auth.getAccessToken(now);
  assert.equal(calls, 1);
});

test('re-exchanges once the cached token is close to expiry', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ access_token: 'ya29.token', expires_in: 3600 }) };
  };
  const auth = createGoogleAuth({ serviceAccount, scope: SCOPE, fetchImpl });
  await auth.getAccessToken(now);
  await auth.getAccessToken(new Date(now.getTime() + 3600 * 1000));
  assert.equal(calls, 2);
});

test('throws a descriptive error when Google rejects the assertion', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 400,
    text: async () => '{"error":"invalid_grant"}',
  });
  const auth = createGoogleAuth({ serviceAccount, scope: SCOPE, fetchImpl });
  await assert.rejects(() => auth.getAccessToken(now), /400.*invalid_grant/s);
});

test('throws when the response carries no access token', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({}) });
  const auth = createGoogleAuth({ serviceAccount, scope: SCOPE, fetchImpl });
  await assert.rejects(() => auth.getAccessToken(now), /no access_token/);
});
