# Runbook

How to operate the monitor day to day, and what to do when something breaks.

## Quick reference

| Thing | Where |
| --- | --- |
| The sheet | [Play Store Monitor](https://docs.google.com/spreadsheets/d/1xW4Vysydlj8E13hHduALupTI2shbg0Q10kSvZckf6TE/edit) |
| Run history and logs | [Actions tab](https://github.com/daemondevpub/vm-play-imformer/actions) |
| Secrets | [Repository secrets](https://github.com/daemondevpub/vm-play-imformer/settings/secrets/actions) |
| Templates | [WhatsApp Manager](https://business.facebook.com/wa/manage/message-templates/?waba_id=1570347831235441) |
| Recipients and test sends | [API Setup](https://developers.facebook.com/apps/1392401916192323/use_cases/customize/api-testing-v2/?product_route=whatsapp-business) |

---

## Adding new apps

**Paste the package name into the next empty cell in column A. That is the
entire process.**

- Order does not matter. Gaps do not matter.
- Duplicates are ignored automatically, case-insensitively.
- Never type in columns B through J. The tool owns those and overwrites them.
- A malformed package name is marked `invalid` in column D and never requested,
  so check column D if an app seems to be ignored.

Within about 13 minutes the app is being checked. It sits at `pending` until its
listing appears, then flips to `live` and you both get an ADDED message.

## Removing an app from monitoring

Delete its row. Rows are matched by package name, not position, so deleting or
inserting rows between runs is safe.

## Reading the sheet

| Column | Meaning |
| --- | --- |
| A | Package name. Yours to edit. |
| B, C | App name and developer account, filled in when the app first goes live |
| D | `pending` (never seen live), `live`, `removed`, or `invalid` |
| E | When it first went live |
| F | When it was last removed |
| G | When its status last changed |
| H | Internal. An unconfirmed observation waiting for a second run. Ignore it. |
| J2 | When the monitor last ran. **This is your heartbeat.** |

**If J2 is more than about an hour old, the monitor has stopped.** That is the
single most useful thing to check.

## Reading the alerts

- **ADDED** — the listing appeared. Either published for the first time, or it
  came back after being gone.
- **REMOVED** — the listing is gone. It is not possible to tell unlisted from
  suspended from self-unpublished, because the public store page looks identical
  in all three cases.

Silence means nothing changed. The monitor only speaks when something happens.

---

## Troubleshooting

### You get a "Run failed" email

Open the failed run in the Actions tab and read the last line of the
**Check listings** step. The run deliberately fails on anything that needs your
attention, so the email is the alerting channel. Do not filter it away.

| What the log says | Cause | Fix |
| --- | --- | --- |
| `WhatsApp send failed: ... API access blocked` | Meta blocked the developer account | Open <https://developers.facebook.com/apps/1392401916192323/required-actions/>, complete the OTP challenge, wait a few minutes |
| `WhatsApp send failed: ... 132001 ... does not exist` | A template was edited, deleted, or renamed | Check the template is Active, and that its name and language still match `TEMPLATE_ADDED` / `TEMPLATE_REMOVED` / `TEMPLATE_LANGUAGE` |
| `WhatsApp send failed: ... 131030` or recipient errors | A number in `WHATSAPP_RECIPIENTS` is not verified with Meta | Verify it on the API Setup page first, then fix the secret |
| `Missing required environment variable: X` | A secret is missing or misnamed | Re-add it, matching the name exactly |
| `Google Sheets API error 403` | The sheet is no longer shared with the service account, or shared as Viewer | Re-share as **Editor** |
| `more than half of all checks were inconclusive` | Google is throttling the runner | Usually transient, resolves itself. If it persists, lower the `CONCURRENCY` variable to 10 |
| `canary listing resolved as live` | Play Store stopped returning 404 for missing apps | Serious: removal detection is broken. Tell whoever maintains this |

**A failed send is never a lost alert.** The change is not recorded, so the next
run detects it again and retries. Fix the cause and the queued alerts deliver
themselves. This is why the emails repeat every few minutes until resolved.

### Alerts stopped but no failure emails

Check `J2` in the sheet.

- **J2 is stale** — the schedule stopped. Most likely GitHub disabled it after
  60 days of repository inactivity; there is a warning email. Re-enable the
  workflow in the Actions tab.
- **J2 is current** — the monitor is running and genuinely has nothing to report.
- **J2 is current but you expected an alert** — check the `SUPPRESS_ALERTS`
  repository variable is deleted. If it exists and is `true`, everything is
  recorded silently and nothing is ever sent.

### Runs are slower than 10 minutes apart

Expected. GitHub's scheduler is best effort and drops runs under load. Measured
11 to 15 minutes against a 5 minute cron. There is no setting that fixes this.

---

## Occasional maintenance

**Adding a third recipient.** Meta's test number allows 5. Verify the number on
the API Setup page first, confirm with a Hello World send, then add it to the
`WHATSAPP_RECIPIENTS` secret, comma separated, digits only. Always in that
order: an unverified number in the secret makes every send fail.

**Editing a message template.** Any edit sends it back for review, and sends
fail until it is approved again. Change the name in the code rather than editing
a live template if you need both to keep working.

**The heartbeat workflow** commits a timestamp weekly so GitHub does not disable
the schedule. If you ever see a "scheduled workflows disabled" email, re-enable
in the Actions tab and check that workflow is still running.

**Nothing expires.** The system user token has no expiry, the deploy key has no
expiry, and the service account key has no expiry. There is no renewal date to
remember.

---

## What to never do

- **Never put a number in `WHATSAPP_RECIPIENTS` before verifying it with Meta.**
  Every send fails, no status is ever recorded, and you get an email every few
  minutes until it is fixed.
- **Never leave `SUPPRESS_ALERTS` set.** It silently disables every alert.
- **Never edit columns B through J.** They are overwritten and your edit will
  confuse the state machine.
- **Never paste the Meta token or the Google service account JSON anywhere
  public**, including issues, commits and logs. If either leaks, revoke it in
  Meta Business Settings or Google Cloud and update the GitHub secret.
