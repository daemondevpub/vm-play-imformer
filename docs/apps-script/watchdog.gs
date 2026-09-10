/**
 * Watchdog: an external, reliable trigger for the monitor workflow.
 *
 * WHY THIS EXISTS
 * GitHub's scheduled workflows are best effort. Its own docs say runs are
 * delayed and may be dropped under load, and in practice the schedule has gone
 * silent for hours at a time while the workflow still showed as "active" and
 * GitHub status reported no incident. That is not something any cron expression
 * can fix.
 *
 * Google Apps Script time triggers fire reliably, cost nothing, and run inside
 * the Google account that already owns the sheet. This script watches the
 * monitor's heartbeat and pokes GitHub only when it has stalled.
 *
 * It is a watchdog, not a replacement. GitHub's own cron stays in place as the
 * primary. When that works, this script does nothing at all.
 *
 * SETUP: see README.md in this folder.
 */

const OWNER = 'daemondevpub';
const REPO = 'vm-play-imformer';
const WORKFLOW_FILE = 'monitor.yml';
const BRANCH = 'main';

const SHEET_ID = '1xW4Vysydlj8E13hHduALupTI2shbg0Q10kSvZckf6TE';
const SHEET_TAB = 'Apps';

/** Cell holding the last run timestamp, written by the monitor in IST. */
const HEARTBEAT_CELL = 'J2';

/** Dispatch once the heartbeat is at least this old. */
const STALE_AFTER_MINUTES = 9;

/** The monitor writes its timestamp in IST, which is UTC+5:30. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Entry point. Install this on a 5 minute time trigger via installTrigger().
 */
function tick() {
  const age = heartbeatAgeMinutes();

  if (age !== null && age < STALE_AFTER_MINUTES) {
    // GitHub's own schedule is keeping up. Nothing to do.
    return;
  }

  console.log(
    age === null
      ? 'heartbeat unreadable, dispatching'
      : `heartbeat is ${age.toFixed(1)} min old, dispatching`,
  );

  dispatchWorkflow();
}

/**
 * Age of the monitor's heartbeat in minutes, or null if it cannot be read.
 * Null is treated as stale: better a redundant run than a silent stall.
 */
function heartbeatAgeMinutes() {
  try {
    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_TAB);
    if (!sheet) return null;

    const raw = String(sheet.getRange(HEARTBEAT_CELL).getDisplayValue()).trim();
    const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);
    if (!match) return null;

    const [, y, mo, d, h, mi] = match.map(Number);
    const instantMs = Date.UTC(y, mo - 1, d, h, mi) - IST_OFFSET_MS;

    return (Date.now() - instantMs) / 60000;
  } catch (error) {
    console.warn(`could not read heartbeat: ${error}`);
    return null;
  }
}

/**
 * Triggers the monitor workflow through GitHub's workflow_dispatch API.
 *
 * Throws on failure, which makes Apps Script email the account owner. That
 * email is the alerting channel for "the watchdog itself is broken".
 */
function dispatchWorkflow() {
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) {
    throw new Error('Script property GITHUB_TOKEN is not set. See README.md.');
  }

  const url =
    `https://api.github.com/repos/${OWNER}/${REPO}` +
    `/actions/workflows/${WORKFLOW_FILE}/dispatches`;

  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    payload: JSON.stringify({ ref: BRANCH }),
    muteHttpExceptions: true,
  });

  const code = response.getResponseCode();

  // A successful dispatch returns 204 No Content.
  if (code !== 204) {
    const body = String(response.getContentText()).slice(0, 300);
    throw new Error(`workflow_dispatch failed with HTTP ${code}: ${body}`);
  }

  console.log('workflow dispatched');
}

/**
 * Run this ONCE by hand to install the 5 minute trigger.
 * Safe to re-run; it clears any previous trigger for tick() first.
 */
function installTrigger() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'tick')
    .forEach((t) => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('tick').timeBased().everyMinutes(5).create();

  console.log('trigger installed: tick() every 5 minutes');
}

/**
 * Run this by hand to check the setup without waiting for a trigger.
 * Reports the heartbeat age and forces one dispatch.
 */
function testNow() {
  const age = heartbeatAgeMinutes();
  console.log(age === null ? 'heartbeat: unreadable' : `heartbeat age: ${age.toFixed(1)} min`);
  dispatchWorkflow();
  console.log('OK. Check the Actions tab for a run with event "workflow_dispatch".');
}
