# Setup Guide

Everything you need to do by hand, once, before the monitor can run. Work
through the parts in order. Part 2 has a waiting step (template approval), so if
you want to parallelize, start Part 2 first and do Part 1 while you wait.

Keep a scratch notepad open. You will collect five values along the way, all of
which go into GitHub in Part 3:

- Sheet ID
- Service account JSON key file
- Meta permanent access token
- Meta phone number ID
- The two WhatsApp numbers in E.164 format

---

## Part 1 — Google Sheet and service account

### 1.1 Create the sheet

1. Go to <https://sheets.google.com> and create a blank spreadsheet.
2. Name it something like `Play Store Monitor`.
3. Rename the first tab to exactly **`Apps`** (double-click the tab at the
   bottom). The name is case-sensitive.
4. In row 1, put these headers in cells A1 through H1:

   | A1 | B1 | C1 | D1 | E1 | F1 | G1 | H1 |
   | --- | --- | --- | --- | --- | --- | --- | --- |
   | Package Name | App Name | Developer Account | Status | First Live | Last Removed | Last Change | _internal |

5. In cell **J1**, type `Last run (IST)`. The tool writes the run timestamp into
   J2 so you can tell at a glance that it is still alive.
6. Put a few real package names in column A starting at A2, to test with later.
7. Add one deliberately fake package name, `com.canary.doesnotexist.monitor`, on
   its own row. This is the canary. It must always show `removed`. If it ever
   shows `live`, Play Store has changed how it answers for missing apps and
   removal detection is broken.
8. Copy the **Sheet ID** from the browser URL. In
   `https://docs.google.com/spreadsheets/d/`**`1AbC...xyz`**`/edit#gid=0`
   the bold part is the ID. Save it to your notepad.

> Only ever type in column A. The tool overwrites B through H on every change.

### 1.2 Create a Google Cloud project

1. Go to <https://console.cloud.google.com>.
2. Click the project dropdown in the top bar, then **New Project**.
3. Name it `play-store-monitor`. Leave organization as-is. Click **Create**.
4. Wait for it to finish, then make sure that project is selected in the top bar.

### 1.3 Enable the Sheets API

1. In the left menu go to **APIs & Services → Library**.
2. Search for **Google Sheets API**.
3. Open it and click **Enable**.

> Enable only the Sheets API. You do not need the Drive API.

### 1.4 Create the service account

1. Go to **APIs & Services → Credentials**.
2. Click **Create Credentials → Service account**.
3. Service account name: `play-store-monitor`. Click **Create and Continue**.
4. On the "Grant this service account access to project" step, click
   **Continue** without selecting a role. It does not need any project role.
5. Click **Done**.

### 1.5 Download the key

1. In the Credentials list, click the service account you just made.
2. Open the **Keys** tab.
3. Click **Add Key → Create new key**, choose **JSON**, click **Create**.
4. A `.json` file downloads. **This is a private key. Do not put it in the
   repository, do not email it, do not paste it into a chat.** Keep it in a
   local folder for now; you will paste its contents into GitHub in Part 3.

### 1.6 Give the service account access to the sheet

1. Open the service account's **Details** tab and copy its email. It looks like
   `play-store-monitor@play-store-monitor-123456.iam.gserviceaccount.com`.
2. Go back to your Google Sheet, click **Share**.
3. Paste that email, set the role to **Editor**, untick **Notify people**, and
   click **Share**.

> Editor is required, not Viewer. The tool writes status columns back.

---

## Part 2 — WhatsApp via Meta Cloud API

### 2.1 Create the Meta app

1. Go to <https://developers.facebook.com> and log in with a Facebook account.
2. Top right, **My Apps → Create App**.
3. If asked for a use case, choose **Other**, then app type **Business**.
4. Give it a name like `Play Store Monitor`, enter your contact email, and
   create it. If it asks to link a Business portfolio, create one, it is free.

### 2.2 Add the WhatsApp product

1. On the app dashboard, find **WhatsApp** in the product list and click
   **Set up**.
2. You land on **WhatsApp → API Setup**.
3. Meta automatically provisions a **test phone number** as the sender. You do
   not need a number of your own and you must not attach a payment method.
4. Copy the **Phone number ID** shown under the "From" number. This is a long
   numeric string. Save it to your notepad as the **Meta phone number ID**.

> Copy the *Phone number ID*, not the phone number itself, and not the WhatsApp
> Business Account ID. They are three different values sitting next to each
> other on that page.

### 2.3 Add your two recipient numbers

1. Still on API Setup, open the **To** dropdown and click **Manage phone number
   list**.
2. Add your number, then your partner's number, each in full international
   format with country code (for India, `91XXXXXXXXXX`).
3. Each number receives a verification code on WhatsApp. Enter each code to
   confirm. Your partner will need to read theirs out to you.
4. Save both numbers to your notepad in E.164 form, digits only, no `+` and no
   spaces. You will enter them comma-separated, e.g. `919876543210,919812345678`.

> The test number can message at most 5 verified recipients, free of charge.
> Two people is well within that.

### 2.4 Create a permanent access token

The token shown on the API Setup page expires in 24 hours and is useless for
this. You need a system-user token that never expires.

1. Go to <https://business.facebook.com/settings> (Business Settings).
2. Left sidebar, under Users, click **System users**.
3. Click **Add**, name it `play-store-monitor-bot`, set role **Admin**, confirm.
4. Select that system user, click **Assign assets**.
   - Choose **Apps**, pick your app, enable **Full control / Manage app**. Save.
   - Click **Assign assets** again, choose **WhatsApp accounts**, pick your
     WhatsApp Business account, enable **Full control / Manage WhatsApp business
     accounts**. Save.
5. Click **Generate new token**.
   - Select your app.
   - Token expiration: **Never**.
   - Tick these permissions: **`whatsapp_business_messaging`** and
     **`whatsapp_business_management`**.
   - Click **Generate token**.
6. **Copy the token immediately.** It is shown exactly once and cannot be
   retrieved later. Save it to your notepad as the **Meta access token**.

> If you miss it, delete the token and generate a new one. No harm done.

### 2.5 Create the two message templates

1. Go to <https://business.facebook.com/wa/manage/message-templates> and make
   sure the correct WhatsApp Business account is selected.
2. Click **Create template**.
   - Category: **Utility**. Not Marketing. Utility approves faster and is the
     correct category for an operational alert.
   - Name: `play_store_app_added` (lowercase and underscores only).
   - Language: **English**.
3. Leave Header and Footer empty. In the **Body**, paste exactly:

   ```
   📱 *PLAY STORE UPDATE - ADDED*

   🏢 *{{1}}*
   📊 App Count: {{2}} → {{3}}

   ✅ Added: *{{4}}* ({{5}})

   🕐 {{6}} IST
   ```

4. Meta will ask for sample values for the variables. Use:

   | Variable | Sample |
   | --- | --- |
   | {{1}} | VASU COMPANY LLC |
   | {{2}} | 12 |
   | {{3}} | 13 |
   | {{4}} | Vasu App Name |
   | {{5}} | com.vasu.app |
   | {{6}} | 2:51 PM |

5. Submit.
6. Repeat the whole step for a second template named
   `play_store_app_removed`, identical except the body:

   ```
   📱 *PLAY STORE UPDATE - REMOVED*

   🏢 *{{1}}*
   📊 App Count: {{2}} → {{3}}

   ❌ Removed: *{{4}}* ({{5}})

   🕐 {{6}} IST
   ```

   Use the same sample values, but swap {{2}} and {{3}} to `13` and `12` so the
   sample reads sensibly.

Approval usually takes minutes, sometimes up to a day. You will see the status
turn **Active** in the template list.

> Do not edit the body text after approval unless you have to. Any edit sends it
> back for re-review. The layout is fixed in the template on purpose, because
> Meta forbids newlines inside variable values.

**If a template is rejected**, the two usual causes are choosing Marketing
instead of Utility, or altering the layout so it starts or ends with a variable.
Fix and resubmit; there is no penalty.

---

## Part 3 — GitHub repository and secrets

### 3.1 Create the repository under the separate account

This repository must **not** live under the primary `Master-Vasu` account. Sign
in to (or create) the separate GitHub account first, then:

1. Create a new repository named `vm-play-imformer` under that account.
2. Visibility: **Public**. This is required for unlimited free Actions minutes at
   a 10-minute cadence.

> Public is safe here. No package names, no app names and no credentials live in
> the repository. The app list is in your Google Sheet and the credentials are in
> encrypted secrets.

**Keeping the accounts genuinely separate.** A public repo exposes more than its
files, so three things have to line up or the two accounts become linkable:

- **Commit identity.** Every commit records an author name and email, publicly
  and permanently. This repository sets a local identity of
  `play-store-monitor <play-store-monitor@users.noreply.github.com>` so it never
  inherits the machine's global git config. Verify with `git config user.email`
  before the first push; if it shows a personal address, fix it before pushing.
- **Push credentials.** The `gh` CLI on this machine is signed in as
  `Master-Vasu` over SSH. Pushing this repo needs the separate account's
  credentials instead. The cleanest route is a fine-grained personal access
  token created on the new account, with **Contents: read and write** on this
  one repository, used over HTTPS. Do not add the new account as a second
  identity on the same SSH key, as one key cannot belong to two accounts.
- **Notification email.** Workflow failure emails go to the new account's
  address. That email is the alerting channel for "Google is throttling us" or
  "a credential expired", so use an inbox that is actually read, or set up
  forwarding.

### 3.2 Add the secrets

In the repository, go to **Settings → Secrets and variables → Actions →
Secrets tab → New repository secret**, and add these five:

| Name | Value |
| --- | --- |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Open the downloaded `.json` key file in a text editor, select all, paste the entire contents including the braces |
| `SHEET_ID` | The sheet ID from step 1.1 |
| `META_ACCESS_TOKEN` | The permanent token from step 2.4 |
| `META_PHONE_NUMBER_ID` | The phone number ID from step 2.2 |
| `WHATSAPP_RECIPIENTS` | Both numbers, comma-separated, e.g. `919876543210,919812345678` |

### 3.3 Add the variables

Switch to the **Variables** tab on the same page and add these. They are not
secret and are optional; skip any you are happy to leave at default.

| Name | Default | Meaning |
| --- | --- | --- |
| `PLAY_REGION` | `US` | Country code used when requesting store pages |
| `CONCURRENCY` | `20` | Parallel requests to Play Store |
| `SHEET_TAB` | `Apps` | Tab name in the spreadsheet |

### 3.4 Check Actions are enabled

Go to **Settings → Actions → General** and confirm **Allow all actions and
reusable workflows** is selected.

---

## Part 4 — First run

Once the code is in place:

1. Go to the **Actions** tab, select the monitor workflow, and click **Run
   workflow** to trigger it by hand rather than waiting for the schedule.
2. Watch the log. It will print counts only, never app names, because these logs
   are public.
3. Open your Google Sheet. Columns B through H should now be populated for the
   packages you added, and cell J2 should show the run time.
4. To verify WhatsApp end to end, add a package name to column A for an app you
   know is already live, then trigger the workflow twice a few minutes apart.
   The first run records the observation, the second confirms it and sends the
   ADDED message.

### Day-to-day use

Paste new package names into column A as you publish. Nothing else. The next run
picks them up automatically.

---

## Things that will bite you later

**The "scheduled workflow disabled" email.** GitHub turns off cron in repos with
no activity for 60 days. A weekly heartbeat workflow guards against this, but if
that email ever arrives, open the Actions tab and re-enable the workflow.

**A failed run emails you.** GitHub notifies the repo owner when a workflow
fails. The monitor deliberately fails the run if more than half its checks come
back inconclusive, so that email is the alarm for "Google is throttling us" or
"a credential broke". Do not filter those emails away.

**Never paste the service account JSON or the Meta token anywhere public**,
including into an issue, a commit, or a log line. If either leaks: delete the
service-account key in Google Cloud and create a new one, or revoke the system
user token in Business Settings and generate a new one, then update the GitHub
secret.
