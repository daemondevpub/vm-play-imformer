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
