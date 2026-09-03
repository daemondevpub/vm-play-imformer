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
  assert.ok(storeUrl('com.vasu app', 'US').includes('id=com.vasu+app'));
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
