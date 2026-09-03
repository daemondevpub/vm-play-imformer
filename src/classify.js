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
