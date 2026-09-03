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
