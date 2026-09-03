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
