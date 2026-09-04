# Play Store Listing Monitor — Design

**Date:** 2026-09-03
**Status:** Approved

## Problem

10 to 20 apps are published to the Google Play Store each day across several
developer accounts. When an app's store listing disappears (unlisted, suspended,
or taken down) or reappears, there is currently no way to find out except by
checking manually. At a few hundred apps and growing toward a thousand, manual
checking is not viable.

## Goal

Detect when a Play Store listing appears or disappears, and send a WhatsApp
message to two people within roughly 20 minutes of the change. Run entirely on
free services with no expiry and no payment method on file.

## Non-goals

- Distinguishing *why* a listing is gone. The public store page cannot tell
  unlisted apart from suspended apart from self-unpublished. All are reported as
  "removed".
- Reading anything from Play Console. This system only observes the public store.
- Tracking ratings, installs, reviews, or listing content changes.

## Detection signal

A GET request to `https://play.google.com/store/apps/details?id=<package>` and
nothing more:

| Response | Meaning |
| --- | --- |
| `200` | Listing exists |
| `404` | Listing gone |
| anything else (429, 5xx, timeout, network error) | Unknown |

Unknown is never a state change. It is retried on the next run. This is what
prevents Google throttling from being misread as a wave of removals.

## Architecture

A single Node.js script run by a GitHub Actions scheduled workflow every 10
minutes, in a **public** repository (public repos get unlimited free Actions
minutes; a private repo's 2000 free minutes/month would cap the cadence at
roughly 30 minutes).

There is no server and no database. GitHub Actions runs are stateless, so **the
Google Sheet is the single source of truth** for all state. It is also the input
surface and the dashboard.

```
GitHub Actions (cron */10)
   |
   v
Node.js script
   |-- reads  --> Google Sheet (package list + last known state)
   |-- checks --> play.google.com (status code only, ~20 concurrent)
   |-- sends  --> Meta WhatsApp Cloud API (template message per event)
   |-- writes --> Google Sheet (only rows whose state changed)
```

### Why not AWS

An earlier revision used AWS Lambda plus DynamoDB. This was dropped because AWS's
current free plan closes the account automatically after six months or when
sign-up credits are exhausted, whichever is first. Keeping the account alive
requires upgrading to pay-as-you-go with a card on file. GitHub Actions has no
such cliff.

## Google Sheet layout

Row 1 is headers. Data starts at row 2. **Column A is edited by the user. The
tool owns columns B through H and never writes to column A.**

| Col | Field | Owner | Example |
| --- | --- | --- | --- |
| A | Package Name | user | `com.vasu.flashlight` |
| B | App Name | tool | `Flashlight Pro` |
| C | Developer Account | tool | `VASU COMPANY LLC` |
| D | Status | tool | `pending` / `live` / `removed` / `invalid` |
| E | First Live (IST) | tool | `2026-08-14 09:20` |
| F | Last Removed (IST) | tool | `2026-09-01 14:05` |
| G | Last Change (IST) | tool | `2026-09-01 14:05` |
| H | _pending flip | tool | internal marker, see below |

Cell `J1` holds the label `Last run (IST)` and `J2` holds the timestamp of the
most recent run, so the sheet doubles as a liveness indicator.

Rows are matched to packages by column A, not by row position, so inserting or
deleting rows between runs is safe.

Duplicate package names are de-duplicated case-insensitively, first occurrence
wins. Package names failing the format check
`^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$` (case-insensitive) are marked `invalid` and
never requested.

## State machine

Every app is in one of `pending`, `live`, `removed`, `invalid`.

New rows in column A start as `pending` (never yet seen live).

**A change must be observed twice in a row before it is applied.** Column H holds
the first, unconfirmed observation. This costs one extra cycle of latency (so
up to about 20 minutes end to end) and eliminates false alarms from transient
failures.

| Current | Check result | Action |
| --- | --- | --- |
| `pending` | exists ×2 | → `live`, send **ADDED** |
| `pending` | gone | stay `pending`, no alert (not yet published) |
| `live` | gone ×2 | → `removed`, send **REMOVED** |
| `live` | exists | clear H |
| `removed` | exists ×2 | → `live`, send **ADDED** |
| `removed` | gone | clear H |
| any | unknown | no change, retry next run |

An app going live for the first time and an app coming back after removal both
send the ADDED message. They are not distinguished.

### Learning the developer account

When an app flips to `live`, and only then, the full page is fetched once to read
the app's display name and developer account into columns B and C. This is 10 to
20 requests a day, not one per app per run.

If that page fetch returns something that is not a real app page (a consent
wall, a captcha, an interstitial), the flip is abandoned and retried next run
rather than recording garbage.

## WhatsApp messages

One message per event, sent as soon as it is detected. No batching, no cap.

### Format

```
📱 PLAY STORE UPDATE - ADDED

🏢 VASU COMPANY LLC
📊 App Count: 12 → 13

✅ Added: Vasu App Name (com.vasu.app)

🕐 2:51 PM IST
```

The developer's app count is the number of rows with status `live` for that
developer account, computed from sheet data rather than stored. When several
apps for one account flip in the same run, they are processed in sequence so the
counts read 12 → 13, then 13 → 14.

### Template design

Meta requires a pre-approved template for business-initiated messages, and
template **parameter values cannot contain newlines, tabs, or 4+ consecutive
spaces**. The multi-line layout therefore has to live in the static template
body, with variables filling only short inline values. Templates also cannot
begin or end with a variable ("dangling parameter"), which both of these satisfy.

Two templates, category **Utility**, language **English**:

`play_store_app_added`
```
📱 *PLAY STORE UPDATE - ADDED*

🏢 *{{1}}*
📊 App Count: {{2}} → {{3}}

✅ Added: *{{4}}* ({{5}})

🕐 {{6}} IST
```

`play_store_app_removed`
```
📱 *PLAY STORE UPDATE - REMOVED*

🏢 *{{1}}*
📊 App Count: {{2}} → {{3}}

❌ Removed: *{{4}}* ({{5}})

🕐 {{6}} IST
```

Parameters in order: developer account, count before, count after, app name,
package name, time in IST (`h:mm AM/PM`).

Parameter values are sanitized before sending: newlines, tabs and runs of spaces
collapsed to a single space, and `#`, `$`, `%` stripped (Meta rejects them in
parameters, and app names such as "100% Free VPN" would otherwise fail).
App names are truncated to keep the rendered body under 1024 characters.

### Delivery

Sent from Meta's free test number to each recipient individually; WhatsApp has no
group send on this API. The test number can message up to 5 verified recipients
free of charge, which covers two people with room to spare.

### Failure handling

If a send fails, the row's new status is **not** written to the sheet. The next
run re-detects the same transition and retries the alert. The failure mode is a
duplicate message, never a missed one.

## Operational constraints

**Public Actions logs.** Anyone can read the workflow logs of a public repo.
The script must never log package names, app names, or developer accounts.
Normal logging is counts only, e.g. `checked 847 · live 830 · pending 15 ·
unknown 2 · changes 2`. Identifying detail appears only in local dry-run output.

**Nothing sensitive in the repo.** The package list lives in the Sheet.
Credentials live in GitHub Actions secrets. The repository holds only generic
code.

**Separate GitHub account.** The repository is hosted under a dedicated account,
not the primary one. Because commit metadata is public and permanent, the repo
carries a local git identity of
`play-store-monitor <play-store-monitor@users.noreply.github.com>` so it cannot
inherit a personal name or email from global git config. Push credentials must
belong to the separate account; the failure-notification email that serves as
the alerting channel arrives in that account's inbox.

**Cron drift.** GitHub's scheduled workflows can be delayed, and runs may be
dropped entirely during peak load. Detection latency is therefore best-effort,
typically 10 to 20 minutes but occasionally worse.

**60-day inactivity.** GitHub disables scheduled workflows in repos with no
activity for 60 days. A weekly heartbeat workflow commits a timestamp file to
prevent this. GitHub also emails a warning before disabling; that email should
not be ignored, as bot commits are not always sufficient to reset the timer.

**Canary row (optional).** The sheet may carry one package name known never to
exist, for example `com.canary.doesnotexist.monitor`. Its check result must
always be `gone`. If it ever comes back `exists`, Play Store has started
answering `200` for missing listings and every removal detection in the system
is silently broken; the run exits non-zero, which triggers GitHub's failure
email.

The check is on the raw result, not on the status column, so the canary row
stays at status `pending` forever. That is correct: a package that has never
been live and is still absent is treated as unpublished, not removed. The
canary is excluded from developer counts and never sends a WhatsApp message.

If no row matches the configured canary package the check simply never fires,
so omitting the canary needs no code change. Tracked apps that happen to be
unpublished are not a substitute, because any of them may legitimately go live
at any time and so cannot serve as an invariant.

**Throttling.** Roughly 1000 requests every 10 minutes go to Google from shared
GitHub runner IPs. Concurrency is capped (default 20) with a browser-like
User-Agent. If more than half of a run's checks come back unknown, the run exits
non-zero, which triggers GitHub's automatic failure email. That is the free
alerting channel for "something is broken".

## Configuration

GitHub Actions secrets:

| Secret | Purpose |
| --- | --- |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Full service-account JSON key |
| `SHEET_ID` | Spreadsheet id from its URL |
| `META_ACCESS_TOKEN` | Permanent system-user token |
| `META_PHONE_NUMBER_ID` | Test number's phone number id |
| `WHATSAPP_RECIPIENTS` | Comma-separated numbers in E.164 |

Repository variables (non-secret): `PLAY_REGION` (default `US`), `CONCURRENCY`
(default `20`), `SHEET_TAB` (default `Apps`).

## Testing

Unit tests, no network:

- Status classification: 200 → exists, 404 → gone, everything else → unknown.
- State machine: table-driven over every combination of current status, check
  result, and pending-flip marker.
- Developer count sequencing when several apps for one account flip in one run.
- Parameter sanitization: newlines, tabs, space runs, `#`, `$`, `%`, truncation.
- Sheet parsing: header mapping, de-duplication, package-name validation.

Manual verification: a `DRY_RUN=true` mode that runs the real check against real
package names, prints exactly what it would send and write, and touches neither
WhatsApp nor the Sheet.

## Known limitations

1. Cannot distinguish unlisted from suspended from self-unpublished.
2. Up to ~20 minutes of detection latency by design, more if GitHub's cron lags.
3. Depends on Meta's developer test number, which is officially a development
   facility rather than a guaranteed-forever product. Swapping senders is a
   configuration change, not a rewrite.
4. Depends on Play Store returning 404 for missing listings. If Google changes
   that to a soft-404 returning 200, detection breaks silently. A canary entry
   (a package known not to exist, expected to always read `removed`) guards
   against this.
