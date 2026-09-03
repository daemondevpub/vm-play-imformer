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
