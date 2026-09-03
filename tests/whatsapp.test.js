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
