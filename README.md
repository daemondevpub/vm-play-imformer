# Play Store Listing Monitor

Watches a list of Google Play packages and sends a WhatsApp message when a
listing appears or disappears.

- **Design:** [`docs/superpowers/specs/2026-09-03-play-store-monitor-design.md`](docs/superpowers/specs/2026-09-03-play-store-monitor-design.md)
- **One-time setup:** [`docs/setup-guide.md`](docs/setup-guide.md)

## How it works

A GitHub Actions cron runs every 10 minutes. For each package it requests the
store page and looks only at the HTTP status code: `200` means the listing
exists, `404` means it is gone, anything else is inconclusive and retried. A
change must be seen on two consecutive runs before it is applied, so a transient
failure never raises a false alarm.

A Google Sheet is the single source of truth. You type package names into column
A; the tool owns columns B through H and writes back only the rows that changed.

## Daily use

Paste new package names into column A of the sheet. Nothing else.

## Running locally

```bash
npm ci
npm test

# Dry run: reads the sheet and checks listings, but writes nothing and sends
# nothing. This is the only mode that prints package and app names.
DRY_RUN=true \
SHEET_ID=... \
GOOGLE_SERVICE_ACCOUNT_JSON="$(cat service-account.json)" \
node src/index.js
```

## Privacy note

This repository is public so that Actions minutes are free. Nothing sensitive
lives here: the package list is in the Google Sheet and all credentials are in
encrypted repository secrets. **Workflow logs are world-readable, so the script
prints counts only and never package names, app names or developer accounts.**

## Exit codes

The run exits non-zero, which makes GitHub email the repository owner, when:

- more than half of all checks were inconclusive, which usually means throttling
- a WhatsApp send failed, in which case the change is retried on the next run
- the canary package resolved as live, meaning removal detection is broken
