import { classify, EXISTS, GONE, UNKNOWN } from './classify.js';
import { parseRows } from './rows.js';
import { decide, sequenceCounts } from './transitions.js';
import { buildMessage } from './messages.js';
import { formatIstDateTime } from './time.js';

/** A run where most checks are inconclusive is a broken run, not a quiet one. */
const UNKNOWN_FAILURE_RATIO = 0.5;

export async function runOnce({ config, sheets, whatsapp, playstore, logger, now = new Date() }) {
  const stamp = formatIstDateTime(now);

  const values = await sheets.readRows();
  const { rows, duplicates } = parseRows(values);

  const checkable = rows.filter((row) => row.status !== 'invalid');
  const results = await playstore.checkAll(
    checkable.map((row) => row.packageName),
    { region: config.playRegion, concurrency: config.concurrency },
  );

  const counts = { [EXISTS]: 0, [GONE]: 0, [UNKNOWN]: 0 };
  const changedRows = new Map();
  const flips = [];
  let canaryBroken = false;

  // Invalid rows are never requested, but the sheet should still say so.
  // Only write one if the sheet does not already record it, so a malformed
  // package name is not rewritten on every single run.
  for (const row of rows) {
    if (row.status !== 'invalid') continue;
    const recordedStatus = (values[row.rowNumber - 2]?.[3] ?? '').trim().toLowerCase();
    if (recordedStatus !== 'invalid' || row.pendingFlip !== '') {
      changedRows.set(row.packageName, { ...row, status: 'invalid', pendingFlip: '' });
    }
  }

  for (const row of checkable) {
    const result = classify(results.get(row.packageName) ?? null);
    counts[result] += 1;

    if (row.packageName === config.canaryPackage) {
      if (result === EXISTS) canaryBroken = true;
      continue;
    }

    const decision = decide({ status: row.status, result, pendingFlip: row.pendingFlip });

    if (decision.action === 'mark') {
      changedRows.set(row.packageName, { ...row, pendingFlip: decision.to });
    } else if (decision.action === 'clear') {
      changedRows.set(row.packageName, { ...row, pendingFlip: '' });
    } else if (decision.action === 'flip') {
      flips.push({ packageName: row.packageName, to: decision.to });
    }
  }

  const marked = [...changedRows.values()].filter((row) => row.pendingFlip !== '').length;

  // Only a confirmed flip to live justifies downloading a full page.
  const details = new Map();
  for (const flip of flips) {
    if (flip.to !== 'live') continue;
    const detail = await playstore.fetchDetails(flip.packageName, { region: config.playRegion });
    if (detail) {
      details.set(flip.packageName, detail);
    } else {
      logger.detail(`could not parse app page for ${flip.packageName}, retrying next run`);
    }
  }

  const events = sequenceCounts({
    rows,
    flips,
    details,
    canaryPackage: config.canaryPackage,
  });

  const byPackage = new Map(rows.map((row) => [row.packageName, row]));
  let sent = 0;
  let sendFailures = 0;

  for (const event of events) {
    const message = buildMessage({
      event,
      now,
      templateAdded: config.templateAdded,
      templateRemoved: config.templateRemoved,
    });

    logger.detail(
      `${event.type}: ${event.appName} (${event.packageName}) under ${event.developer} ` +
        `${event.countBefore} -> ${event.countAfter}`,
    );

    // Suppressed alerts still count as delivered, so the flip is persisted.
    // That is the difference from a dry run, which persists nothing.
    let delivered = true;
    if (!config.dryRun && !config.suppressAlerts) {
      for (const to of config.recipients) {
        const outcome = await whatsapp.sendTemplate({
          to,
          templateName: message.templateName,
          params: message.params,
        });
        if (outcome.ok) {
          sent += 1;
        } else {
          delivered = false;
          sendFailures += 1;
          logger.error(`WhatsApp send failed: ${outcome.error}`);
        }
      }
    }

    // A flip is persisted only once every recipient has it. If delivery failed,
    // the row stays as it was so the next run re-detects and retries. A repeat
    // message is acceptable; a lost one is not.
    if (!delivered) continue;

    const row = byPackage.get(event.packageName);
    const updated = {
      ...row,
      appName: event.appName,
      developer: event.developer,
      status: event.type === 'added' ? 'live' : 'removed',
      lastChange: stamp,
      pendingFlip: '',
    };
    if (event.type === 'added' && !row.firstLive) updated.firstLive = stamp;
    if (event.type === 'removed') updated.lastRemoved = stamp;

    changedRows.set(event.packageName, updated);
  }

  const flipped = events.length;
  const tracked = rows.length;
  const totalChecked = counts[EXISTS] + counts[GONE] + counts[UNKNOWN];
  const mostlyUnknown =
    totalChecked > 0 && counts[UNKNOWN] / totalChecked > UNKNOWN_FAILURE_RATIO;

  if (!config.dryRun) {
    await sheets.writeChanges({ rows: [...changedRows.values()], lastRunAt: stamp });
  }

  const summary = {
    tracked,
    exists: counts[EXISTS],
    gone: counts[GONE],
    unknown: counts[UNKNOWN],
    invalid: rows.length - checkable.length,
    duplicates,
    marked,
    flipped,
    sent,
    sendFailures,
    canaryBroken,
  };

  logger.info(
    `tracked ${summary.tracked} · live ${summary.exists} · gone ${summary.gone} · ` +
      `unknown ${summary.unknown} · invalid ${summary.invalid} · marked ${summary.marked} · ` +
      `changed ${summary.flipped} · messages ${summary.sent}`,
  );

  if (config.suppressAlerts && flipped > 0) {
    logger.warn(
      `SUPPRESS_ALERTS is on: ${flipped} state change(s) recorded without sending any message`,
    );
  }
  if (canaryBroken) {
    logger.error('canary listing resolved as live; removal detection may be broken');
  }
  if (mostlyUnknown) {
    logger.error('more than half of all checks were inconclusive; likely throttled');
  }

  const exitCode = canaryBroken || mostlyUnknown || sendFailures > 0 ? 1 : 0;
  return { exitCode, summary };
}
