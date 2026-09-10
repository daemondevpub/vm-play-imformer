# Watchdog setup

One-time setup, about 10 minutes. Makes the monitor keep running even when
GitHub's scheduler stalls.

## Why

GitHub's scheduled workflows are best effort. On 10 September 2026 the schedule
went silent for over four hours while the workflow still showed as **active**
and GitHub's status page reported no incident. Nothing in the repository can fix
that, because the failure is GitHub declining to start the run at all.

This watchdog runs in Google Apps Script, inside the same Google account that
owns the sheet. Every 5 minutes it reads the monitor's heartbeat in cell `J2`.
If that heartbeat is 9 minutes old or more, it triggers the workflow directly
through GitHub's API.

GitHub's own cron stays in place and remains the primary trigger. When it is
working, this script reads one cell and does nothing.

## Step 1 — Create a GitHub token

As **daemondevpub**, go to Settings, Developer settings, Personal access tokens,
Fine-grained tokens, Generate new token.

| Field | Value |
| --- | --- |
| Name | `watchdog dispatch` |
| Resource owner | daemondevpub |
| Repository access | Only select repositories, then `vm-play-imformer` |
| Repository permissions | **Actions: Read and write** |
| Expiration | your choice, 1 year maximum |

Actions write is all it needs. Do not grant Contents write; this token should
never be able to change code.

Copy the token. It is shown once.

> Set a calendar reminder for the expiry date. When this token expires the
> watchdog stops silently, and you fall back to GitHub's unreliable schedule.

## Step 2 — Create the Apps Script project

1. Open the [monitor sheet](https://docs.google.com/spreadsheets/d/1xW4Vysydlj8E13hHduALupTI2shbg0Q10kSvZckf6TE/edit).
2. **Extensions → Apps Script**. A new project opens, bound to the sheet.
3. Delete the placeholder `myFunction` code.
4. Paste the entire contents of [`watchdog.gs`](watchdog.gs).
5. Click the save icon. Rename the project to `Play Store Monitor Watchdog`.

## Step 3 — Store the token

1. In the Apps Script editor, click the gear icon (**Project Settings**) on the left.
2. Scroll to **Script Properties**, click **Add script property**.
3. Property: `GITHUB_TOKEN`. Value: the token from step 1. Save.

Script properties are private to the project and are not part of the sheet, so
nobody you share the sheet with can read the token.

## Step 4 — Authorise and test

1. Back in the editor, select **`testNow`** from the function dropdown and click **Run**.
2. Google asks for authorisation the first time. Approve it. If it warns the app
   is unverified, choose Advanced, then "Go to Play Store Monitor Watchdog".
   That warning is because you wrote the script yourself; it has not been
   through Google's review, which is normal for personal scripts.
3. The execution log should print the heartbeat age and `workflow dispatched`.
4. Check the [Actions tab](https://github.com/daemondevpub/vm-play-imformer/actions).
   A run should appear within seconds, labelled **workflow_dispatch** rather
   than Scheduled.

If it fails, the log says why. `HTTP 404` almost always means the token lacks
Actions write, or was scoped to the wrong repository.

## Step 5 — Install the trigger

1. Select **`installTrigger`** from the function dropdown and click **Run**.
2. The log should print `trigger installed: tick() every 5 minutes`.
3. Confirm under the clock icon (**Triggers**) on the left: one time-driven
   trigger for `tick`, every 5 minutes.

Done. Nothing else to do.

## How to tell it is working

- **Actions tab**: most runs stay labelled *Scheduled*. Occasional
  *workflow_dispatch* runs are the watchdog covering a gap. That is it working.
- **All runs suddenly workflow_dispatch**: GitHub's scheduler has stopped
  entirely and the watchdog is carrying the whole load. Fine, but worth knowing.
- **Cell J2** should never be more than about 15 minutes old.

## If the watchdog itself breaks

Apps Script emails the account owner when a trigger throws. That email is the
alert. Common causes:

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Script property GITHUB_TOKEN is not set` | Property missing or misnamed | Re-add it in Project Settings |
| `HTTP 404` | Token lacks Actions write, or wrong repo | Regenerate with the right scope |
| `HTTP 401` | Token expired or revoked | Generate a new one, update the property |
| No emails, no dispatches, J2 stale | Trigger was deleted | Run `installTrigger` again |

## Quotas

Well inside Google's free consumer limits: 288 executions a day against a
20,000 URL-fetch limit, and roughly 5 minutes of runtime a day against a 90
minute limit.
