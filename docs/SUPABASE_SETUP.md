# Supabase setup

Project: **Duty Scheduler** (`ukxxpbivgxyxharhxgqf`). The Site runtime already has its public project URL and publishable key. No service-role key is used by the app. Google credentials must be configured before the first login.

## 1. Create the Google OAuth client

Follow [Supabase's current Google setup](https://supabase.com/docs/guides/auth/social-login/auth-google).

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create or select a project, such as **Duty Scheduler**.
2. Open **Google Auth Platform** and configure the app branding/contact details. Choose an audience that allows the team's Google accounts. For a testing app, add your Google email under **Audience → Test users**; add teammates when ready.
3. Under **Data Access**, use only `openid`, `userinfo.email` and `userinfo.profile`.
4. Under **Clients**, create an OAuth client of type **Web application** with these exact values:

| Setting | Value |
|---|---|
| Authorized JavaScript origin | `https://duty-rota.keshet-mako-7367.chatgpt.site` |
| Authorized redirect URI | `https://ukxxpbivgxyxharhxgqf.supabase.co/auth/v1/callback` |

## 2. Configure Supabase

In **Authentication → Sign In / Providers → Google**, enable Google and enter the client ID and secret from Google Cloud. Enter the secret only in Supabase, never in this repository or chat.

In **Authentication → URL Configuration** set:

| Setting | Value |
|---|---|
| Site URL | `https://duty-rota.keshet-mako-7367.chatgpt.site` |
| Allowed redirect URL | `https://duty-rota.keshet-mako-7367.chatgpt.site/` |

## 3. First login and explicit admin promotion

After both dashboards are configured, open the app and choose **Continue with Google**. This Google account can be different from the ChatGPT account. Supabase creates the real login identity; the app creates a pending engineer profile using the Google display name. Nothing is generated or assigned automatically.

The first account is **not** automatically made admin. Identify and confirm its actual account ID/email, then use a trusted SQL connection to promote that exact row in `duty_members` and increment `duty_workspace.revision` in one transaction. There is no email reservation table. Reloading or **Check approval** then enters the workspace.

Approved admins can approve later join requests and change approved members' roles in **Team & fairness**. Multiple admins are supported, and at least one active approved admin must remain. Every admin can also receive duties. Approved people can change their own display name through their avatar; subsequent logins do not overwrite it.

The current Site is owner-private. Team members also need Sites access or an agreed team-accessible hosting URL. Changing hosting requires updating the Google origin and Supabase redirect URLs.

## Current database

| Table | Purpose |
|---|---|
| `auth.users` (Supabase-owned) | Verified login identities; not application-managed sample users. |
| `duty_members` | Profile, role FK, approval-status FK, active flag, seniority order and color. Deactivation retains history. |
| `duty_workspace` | One revision counter for atomic saves and stale-edit detection. |
| `duty_months` | Deadline, status FK, generated flag, current publication FK and monotonic version sequence. |
| `duty_constraints` | Engineer/date, constraint-type FK and a private note. |
| `duty_assignments` | Duty dates, primary/emergency member FKs, title, extra points, computed total points and publication FK. NULL publication means draft. |
| `duty_publications` | Version ID, month FK, sequence number, publisher FK and timestamp. |
| `duty_swap_requests` | Own/admin-visible requests, source version/duty FKs, date/member snapshots, resolution and explicit override audit reason. |
| `duty_roles` | Engineer/admin definitions and the admin capability. |
| `duty_member_statuses` | Pending, approved and declined definitions. |
| `duty_month_statuses` | Draft and published definitions. |
| `duty_constraint_types` | Unavailable and preferred definitions. |

The former `manager_identity`, `duty_specials` and `duty_split_weekends` tables have been removed. Their old creation statements remain in historical migrations so the repository can reproduce the schema in order.

A regular duty spans one date; an intact weekend spans Friday through Sunday and is one stored row. Split or special weekend dates use separate rows in the same duty table. Extra points belong to the duty date and survive changing the assigned engineer. Selecting a special range in the UI sets those dates' extra points together.

Publishing creates a new immutable version and copies its duty rows, keeping actual foreign keys rather than a JSON snapshot. Admins can preview old versions in a seven-column calendar, restore one to a draft or delete one after confirmation. Restoring preserves the current publication until Publish is clicked; a boundary weekend may also reopen an adjacent month's draft. Deleting the live version selects the newest remaining version; deleting the last version unpublishes that month. Version numbers are not reused.

## Permissions and validation

- Pending/rejected/inactive accounts see only their own membership record and harmless lookup definitions.
- Approved active engineers see current published duties and their own constraints. Notes are visible only to that engineer and admins.
- Admins see drafts/history and manage approvals, roles, deactivation, deadlines, duties and publications.
- Client table writes are denied. Checked RPCs enforce permissions and lock/check the global revision. Profiles and roles have separate checked operations.
- Constraints use the deadline date in Asia/Jerusalem, inclusive of that day. Publication closes the month's engineer edits; admins can reopen a draft.
- Refresh runs on focus and every 30 seconds while the app is visible.

Migrations through `20260918133851` are already applied to the connected project. The new swap migration is unapplied; see its steps below. Earlier migrations were created with the Supabase CLI and reconciled to the remote migration version IDs. Apply the full sequence only to a separate new development project. The consolidation migration deliberately refuses to discard unexpected pre-existing schedule data.

`supabase/tests/access.sql` creates synthetic auth/member records inside one transaction and rolls everything back; it sends no email and refuses to run on a project with real members. Use an empty development project after real onboarding begins. Checks cover explicit first-admin promotion, multiple admins, last-admin protection, FK values, own-name edits, private notes, stale revisions, publication versions, stable points, boundary-weekend restores, deletion and deactivation.

The security advisor reports no findings. The fresh, empty database has informational [unused-index notices](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index); foreign-key indexes are retained for real usage.

```sh
node --test tests/*.test.mjs
pnpm exec tsc --noEmit
pnpm build
```

## Local development with the existing hosted project

1. Copy `.env.local.example` to `.env.local` at the repository root. Set
   `SUPABASE_URL` to your existing project's URL and `SUPABASE_PUBLISHABLE_KEY`
   to its publishable key (`sb_publishable_...`), available in the Supabase
   project's Connect dialog / API Keys settings. Do not use an anon JWT,
   secret/service-role key or Google client secret. Fill these in locally only;
   `.env.local` is ignored by Git.
2. In Supabase **Authentication → URL Configuration**, add
   `http://localhost:5173/` to **Redirect URLs**. Keep the deployed Site URL and
   existing redirect entries. If you use another hostname or port, add its
   exact origin with a trailing slash instead.
3. In the existing Google OAuth web client, add `http://localhost:5173` under
   **Authorized JavaScript origins**. Keep the hosted Supabase callback
   `https://ukxxpbivgxyxharhxgqf.supabase.co/auth/v1/callback` under
   **Authorized redirect URIs**; the database/Auth service is still hosted,
   so no localhost Supabase callback or local Google secret is needed. Ensure
   Google is enabled in Supabase and your account is an allowed test user if
   the Google app is in testing. See [Google setup](https://supabase.com/docs/guides/auth/social-login/auth-google).
4. Restart `pnpm dev` and open `http://localhost:5173`. In browser DevTools,
   confirm `/api/config` returns **200** (do not copy its response into logs or
   chat), then choose **Continue with Google** using your existing account.
   Confirm the redirect returns to localhost and your approved workspace opens;
   pending accounts still require manager approval. Reload to verify the session
   persists. Use the same hostname throughout the login flow.

`/api/config` returns **503** when its URL is missing or its key is missing or
does not begin with `sb_publishable_`. The deployed runtime's bindings are not
downloaded into a local checkout. Vinext loads `.env.local`, and Cloudflare's
local worker environment also reads it; no `VITE_` or `NEXT_PUBLIC_` prefix is
needed. Avoid mixing `.dev.vars` with `.env.local`: Cloudflare prioritizes
`.dev.vars` and skips dotenv files when it exists. Restart after changing local
configuration. See [Cloudflare environment loading](https://developers.cloudflare.com/workers/local-development/environment-variables/).

Local login uses the same accounts, permissions and live team data as deployment.
The app has no demo login or local-data fallback.

Push notifications, calendar subscriptions and full action audit logs remain future work. Real Google OAuth must be checked after provider setup; database role tests do not replace that check.

## Published duty swaps: migration and verification

The feature adds **`supabase/migrations/20261009145431_published_duty_swaps.sql`**.
It has not been applied to the hosted project. The earlier migrations above remain
historical; do not replay them against the existing project.

Swap requests are independent of drafts. Both duties must start after today in
Asia/Jerusalem and belong to the same owning month (Saturday belongs to Friday).
Combined weekends swap as whole duties; split Friday/Saturday rows stay split.
Request submission checks availability, active approved members, emergency-role
duplication, overlapping dates and weekend caps. Approval rechecks all of these
under the workspace revision lock. A source version superseded or deleted after
submission cannot be approved; reject/cancel it and submit a new request.
An admin can explicitly override availability on approval with a required reason,
recorded alongside the approving admin, time and resulting publication. Weekend
caps follow the existing draft-swap rule: a swap cannot increase an engineer's
weekend count above one. Consecutive duties remain allowed. Constraint notes are
never included in requests. Other engineers cannot read a request or its explanation.
Admin rejection and requester cancellation leave all assignments unchanged.
Version deletion retains request dates/members/status, with deleted version/duty
references set to NULL. Approval preserves every existing version and copies only
the current published rows; it leaves draft rows and the month's draft status intact.
Admins see their draft calendar; the Swap Requests picker always uses live published
duties, including when a draft has been reopened. Restore the new version explicitly
if you want those swapped assignments in a draft before a later ordinary publication.

### Empty local Supabase database (PowerShell)

Requires Docker Desktop, pnpm and a PostgreSQL `psql` client. Use a disposable
directory so this does not pick up the repository's hosted project link or env file:

```powershell
$repo = (Get-Location).Path
$swapTestRoot = Join-Path $env:TEMP ('duty-swaps-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $swapTestRoot | Out-Null
pnpm dlx supabase --workdir $swapTestRoot init
Copy-Item -LiteralPath (Join-Path $repo 'supabase/migrations') -Destination (Join-Path $swapTestRoot 'supabase') -Recurse
pnpm dlx supabase --workdir $swapTestRoot start
# Use the local DB URL printed by start (normally port 54322).
psql 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' -v ON_ERROR_STOP=1 -f supabase/tests/access.sql
psql 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' -v ON_ERROR_STOP=1 -f supabase/tests/swaps.sql
pnpm dlx supabase --workdir $swapTestRoot stop
```

If port 54322 is reserved, change `[db].port` in the disposable config and use
that port in both `psql` commands. `start` applies migrations only in this local
instance. Both SQL tests refuse real members and roll their fixtures back. Never
point these fixtures at your existing hosted project or run `db reset --linked`.

### Apply to your existing hosted project yourself

After reviewing the PR and local tests, back up the database. In your Supabase
project's SQL Editor, open the exact new migration above, review it and execute it
**once**. It creates the request table, policies, checked RPCs and extends `duty_load`;
it does not rewrite schedules. Keep a record of this migration's version
`20261009145431`. If you maintain CLI migration history, use
`supabase migration repair 20261009145431 --status applied --linked` afterward
only once you have confirmed the SQL succeeded and the CLI is linked to the intended
project. This repair records history; it does not apply SQL. Do not run the fixture
tests on the hosted project. Do not deploy automatically; restarting local `pnpm dev`
is enough to test the branch against a project where you have applied the migration.

### Three-browser acceptance check

Use three separate browser profiles: approved admin A, approved engineer B and
approved engineer C. For isolated UI testing, configure the local app against a
separate development Supabase project with those three accounts; pointing at the
hosted project means UI actions change real data.

1. A publishes a future month with duties for B/C, a combined weekend, split weekend
   and a special date. Record the version number, date points and emergency cover.
2. B taps an owned future calendar duty, chooses C's duty, adds an explanation and
   submits. Verify pending count, unchanged publication, persistence after refresh
   and sign-out/sign-in. C sees no request or explanation. B can cancel; repeat and
   have A reject. Both actions preserve the schedule and show a persisted status.
3. Submit again. A reopens the draft and changes an unrelated date. Approve from
   Swap Requests. Verify a new version, exchanged primaries, identical secondary
   assignments/points/weekend spans, unchanged draft and preserved older version.
   B/C refresh or refocus to see the swap; polling also refreshes within 30 seconds.
4. Try a second-weekend swap, unavailable dates, emergency-role duplication,
   today's duty and an inactive participant. These must fail safely. After a valid
   request, A adds a conflicting availability constraint; approval fails until A
   explicitly selects the override and supplies an audit reason.
5. Create competing requests against one version. Approve one, then try the other
   after refresh: it must fail as stale. Check double approval and cancel/approve
   races using two profiles; only one terminal resolution can succeed. Supersede
   the source via ordinary publication and verify its pending requests cannot approve.
6. Repeat at narrow mobile width in English/Hebrew: check RTL, wrapped names,
   keyboard focus, labelled selections, dialog close and real-device taps/scrolling.
