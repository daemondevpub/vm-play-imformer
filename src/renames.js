/**
 * Developer account rename handling.
 *
 * A developer account is identified only by its display name. Play Store does
 * not expose a stable id: the developer link is `/store/apps/developer?id=<the
 * name>`, so when the name changes the id changes with it. There is nothing
 * immutable to key on.
 *
 * That makes a rename look like a brand new account. Every row still carries
 * the old name, so the renamed account appears to have zero live apps and the
 * next app to go live reports "0 -> 1" instead of "8 -> 9".
 *
 * Renames are therefore detected rather than looked up. When an app goes live
 * under a developer name we have never seen, one app from each known account is
 * re-fetched. If any of them now reports the new name, that account was
 * renamed, and every row belonging to it is resynced before counts are taken.
 */

/** Never probe more accounts than this in one run, to bound the request cost. */
const MAX_PROBED_ACCOUNTS = 30;

/** Pages to try per account; the first one may have just been taken down. */
const PROBES_PER_ACCOUNT = 2;

/** Live packages grouped by the developer name currently recorded for them. */
export function liveByDeveloper({ rows, canaryPackage }) {
  const grouped = new Map();

  for (const row of rows) {
    if (row.packageName === canaryPackage) continue;
    if (row.status !== 'live') continue;
    if (!row.developer) continue;

    if (!grouped.has(row.developer)) grouped.set(row.developer, []);
    grouped.get(row.developer).push(row.packageName);
  }

  return grouped;
}

/**
 * Developer names arriving on a flip to live that no live row claims yet.
 * Each one is either a genuinely new account or the new name of an old one.
 */
export function findUnknownDevelopers({ rows, flips, details, canaryPackage }) {
  const known = liveByDeveloper({ rows, canaryPackage });
  const unknown = new Set();

  for (const flip of flips) {
    if (flip.to !== 'live') continue;
    if (flip.packageName === canaryPackage) continue;

    const detail = details.get(flip.packageName);
    if (!detail?.developer) continue;
    if (known.has(detail.developer)) continue;

    unknown.add(detail.developer);
  }

  return unknown;
}

/**
 * Works out which recorded developer names have been renamed to which new ones.
 * Returns a Map of old name to new name, empty when nothing has been renamed.
 *
 * Costs nothing on a normal run: the probes only happen when an unfamiliar
 * developer name actually turns up.
 */
export async function resolveRenames({
  rows,
  flips,
  details,
  playstore,
  region,
  canaryPackage,
  logger,
}) {
  const unknown = findUnknownDevelopers({ rows, flips, details, canaryPackage });
  if (unknown.size === 0) return new Map();

  const known = liveByDeveloper({ rows, canaryPackage });
  const renames = new Map();
  let probed = 0;

  for (const [developer, packages] of known) {
    if (unknown.size === 0) break;
    if (probed >= MAX_PROBED_ACCOUNTS) break;
    probed += 1;

    for (const packageName of packages.slice(0, PROBES_PER_ACCOUNT)) {
      const detail = await playstore.fetchDetails(packageName, { region });

      // Unreadable page, most likely just taken down. Try the next one.
      if (!detail?.developer) continue;

      if (detail.developer !== developer && unknown.has(detail.developer)) {
        renames.set(developer, detail.developer);
        unknown.delete(detail.developer);
        logger?.detail(`developer renamed: "${developer}" -> "${detail.developer}"`);
      }

      // The page read fine, so this account's current name is settled.
      break;
    }
  }

  return renames;
}

/**
 * Rewrites the recorded developer name on every affected row, and queues those
 * rows to be written back. Mutates `rows` and `changedRows` in place so that
 * later stages, including the count, see the corrected names.
 *
 * Returns the packages whose developer name changed.
 */
export function applyRenames({ rows, changedRows, renames }) {
  if (renames.size === 0) return [];

  const touched = [];

  for (const row of rows) {
    const renamedTo = renames.get(row.developer);
    if (!renamedTo) continue;

    row.developer = renamedTo;

    // A row may already be queued from this run's mark/clear pass. Keep that
    // pending copy in step rather than overwriting its other changes.
    const pending = changedRows.get(row.packageName);
    if (pending) pending.developer = renamedTo;
    else changedRows.set(row.packageName, { ...row });

    touched.push(row.packageName);
  }

  return touched;
}
