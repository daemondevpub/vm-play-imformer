import { createGoogleAuth } from './googleauth.js';
import { rowToCells } from './rows.js';

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const API_ROOT = 'https://sheets.googleapis.com/v4/spreadsheets';

/** The cell that records when the monitor last ran, so the sheet shows liveness. */
const LAST_RUN_CELL = 'J2';

function defaultAuthFactory(serviceAccount) {
  return createGoogleAuth({ serviceAccount, scope: SCOPE });
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
