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
| `duty_swap_requests` | Requester/consent/admin-visible requests, original slot snapshots/FKs, current counterpart, persisted consent, resolution and override audit reason. |
| `duty_roles` | Engineer/admin definitions and the admin capability. |
| `duty_member_statuses` | Pending, approved and declined definitions. |
| `duty_month_statuses` | Draft and published definitions. |
| `duty_constraint_types` | Unavailable and preferred definitions. |

The former `manager_identity`, `duty_specials` and `duty_split_weekends` tables have been removed. Their old creation statements remain in historical migrations so the repository can reproduce the schema in order.

A regular duty spans one date; an intact weekend spans Friday through Sunday and is one stored row. Split or special weekend dates use separate rows in the same duty table. Extra points belong to the duty date and survive changing the assigned engineer. Selecting a special range in the UI sets those dates' extra points together.

Publishing creates a new immutable version and copies its duty rows, keeping actual foreign keys rather than a JSON snapshot. Admins can preview old versions in a seven-column calendar, restore one to a draft or delete one after confirmation. Restoring preserves the current publication until Publish is clicked; a boundary weekend may also reopen an adjacent month's draft. Deleting the live version selects the newest remaining version; deleting the last version unpublishes that month. Version numbers are not reused.

## Permissions and validation

The [browser regression baseline](../README.md#regression-baseline-before-nextjs)
uses intercepted synthetic auth/RPC responses and blocks external browser requests.
It needs no hosted project or Google credentials and must remain offline through
framework migrations. Its UI/client-contract assertions do not replace the SQL
permission and transaction checks below; never run those against real members.

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

The feature requires both new migrations, in this order:

1. `supabase/migrations/20261009145431_published_duty_swaps.sql`
2. `supabase/migrations/20261009161959_swap_consent_and_reassignment.sql`

Neither is applied to the hosted project. Read-only catalog and migration-history
checks on 2026-10-09 confirmed that `public.duty_request_swap` and
`public.duty_resolve_swap` do not exist and history ends at `20260918133851`.
This is the cause of the schema-cache error. The client parameter names match
`duty_request_swap(p_from uuid,p_to uuid,p_explanation text,p_revision bigint)`;
parameter order in the error is immaterial. Reloading the cache cannot create a
missing function. The migration explicitly grants execution to `authenticated`,
and its checked operations still require approved active membership.

Swap requests are independent of drafts. Both duties must start after today in
Asia/Jerusalem and belong to the same owning month (Saturday belongs to Friday).
Combined weekends swap as whole duties; split Friday/Saturday rows stay split.
Creation checks availability, approved active members, emergency-role duplication,
no overlapping duties and weekend caps. Engineers drag their own primary duty
onto another engineer's duty using the existing desktop/mobile long-press gesture.
Keyboard users select their own date with Enter/Space, then another engineer's
date; Escape cancels selection. Dropping opens an EN/HE confirmation with both
dates/engineers and an optional explanation; submission never changes assignments.
Admins retain draft editing and can switch their calendar to Published to request
swaps using the authoritative publication instead of draft rows.

Workflow: `awaiting_engineer` -> counterpart Accept -> `awaiting_admin` -> admin
Approve -> `approved`. Counterpart Decline yields `declined`; admin Reject yields
`rejected`; requester Cancel in either pending state yields `cancelled`. Only final
approval copies the current publication into a new immutable version. Availability
conflicts added after creation can be acknowledged at consent but require an
explicit admin override reason at approval. Weekend caps follow the draft-swap
rule: a swap cannot increase an engineer's weekend count above one. Secondary
cover, special date points/spans, draft rows/status and historical versions remain
intact. Constraint notes are never copied into requests.

Original dates and exclusive ends identify slots across publication copies. Every
live publication-pointer change (including ordinary publication or live-version
deletion) reconciles pending requests under the existing workspace lock. If the
counterpart duty changes from B to C, `other_id` becomes C, status returns to
`awaiting_engineer` and `accepted_by`/`accepted_at` are cleared. C must explicitly
accept. If the requester loses their original slot, a slot disappears/changes span,
a date expires on revalidation, or no live publication remains, the request becomes
`invalidated`. Unrelated slot changes preserve consent. Resolution revalidates
current owners and uses the current publication; global revision checks reject
stale concurrent actions before any writes. Deleting the original source version
sets its historical FKs to NULL but retains dates/members and does not destroy a
valid request against unchanged current slots. Existing v1 approvals keep their
historical audit records; consent is never fabricated for them. Existing pending
v1 requests require consent, and duplicate pending slot pairs retain the newest
request while older duplicates become Invalidated.

RLS allows engineers to read initiated requests and incoming requests currently
requiring their consent; approved admins additionally see requests awaiting admin
approval. A former counterpart immediately loses incoming visibility on reassignment.
The compact list spans all months, puts the current user's actions first and is
entirely absent when that user has no visible requests. Polling/focus refresh uses
the existing 30-second mechanism; no push/email notifications are sent.

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
psql 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' -v ON_ERROR_STOP=1 -f supabase/tests/swap-upgrade.sql
# Run only after both rollback fixtures finish. Use the actual local DB container name.
node supabase/tests/swap-races.mjs supabase_db_<disposable-project>
pnpm dlx supabase --workdir $swapTestRoot stop
```

If port 54322 is reserved, change `[db].port` in the disposable config and use
that port in both `psql` commands. `start` applies migrations only in this local
instance. Both SQL tests refuse real members and roll their fixtures back. Never
point these fixtures at your existing hosted project or run `db reset --linked`.

`swap-upgrade.sql` rebuilds the swap feature inside a rollback transaction, then
applies the actual v1/v2 migrations with synthetic historical resolutions and
duplicate pending rows. It verifies unchanged audit/history data and fresh consent.
`swap-races.mjs` uses two real PostgreSQL connections for approve/approve,
approve/cancel and consent/reassignment races, creates only synthetic fixtures in
an empty disposable local container, and cleans them up after each case.

The optional browser regression is `tests/browser/swaps.mjs`. With Playwright
available externally (do not add it to application dependencies), run `pnpm build`,
then `pnpm start` in a separate terminal and `node tests/browser/swaps.mjs`.
Use `DUTY_PREVIEW_URL` if the preview is not at `http://127.0.0.1:8787`, and
`DUTY_CHROME_PATH` for another installed Chrome path. Its four browser contexts
mock every Supabase endpoint with synthetic data; it tests UI/gesture wiring,
not database permissions or real-device touch behavior. `NODE_PATH` can point to
an existing external Playwright installation.

### Apply to your existing hosted project yourself

1. Review the PR and back up the intended database. Confirm the project's URL
   matches your local configuration; the existing project ref is
   `ukxxpbivgxyxharhxgqf`. Never run fixture tests on the hosted project.
2. In that project's SQL Editor run these **read-only** diagnostics:

   ```sql
   select version,name from supabase_migrations.schema_migrations order by version;
   select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid),p.proargnames,
          has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname in ('duty_request_swap','duty_resolve_swap');
   ```

3. If the first migration is absent and the swap functions/table are absent,
   open `20261009145431_published_duty_swaps.sql` from this branch. Paste its
   **entire contents**, wrapped with `BEGIN;` before and `COMMIT;` after, and run
   once. Then run the entire `20261009161959_swap_consent_and_reassignment.sql`
   the same way, once. Do not replay earlier migrations. If the original swap
   migration is already applied, run only the consent/reassignment migration.
   If history and actual schema disagree, stop and reconcile the discrepancy
   before applying either file; do not blindly rerun a partially applied migration.
4. Re-run the function diagnostic: confirm exactly the documented argument names
   and `authenticated_execute=true`. The follow-up migration sends
   `NOTIFY pgrst, 'reload schema';`. If the functions exist with correct grants
   but PostgREST still reports a schema-cache miss, run that statement manually
   and retry after the reload. This refresh is the documented
   [Supabase schema-cache procedure](https://supabase.com/docs/guides/troubleshooting/refresh-postgrest-schema).
5. If using CLI migration history, inspect `supabase migration repair --help` and
   verify the CLI is linked to the intended project. **Only after successful SQL
   and schema verification**, record each manually applied migration:

   ```sh
   supabase migration repair 20261009145431 --status applied --linked
   supabase migration repair 20261009161959 --status applied --linked
   ```

   Repair records history; it does not execute migration SQL. Record only versions
   actually applied, and do not use `db reset --linked` or replay the historical
   consolidation migration. No remote migration, cache reload, history repair,
   production write or deployment was performed by this implementation task.
6. Restart local `pnpm dev` and repeat the acceptance checks below in a separate
   development project. Testing against the hosted project changes real data.

### Four-browser acceptance check

Use separate browser profiles for approved admin, engineer A, engineer B and
engineer C in an isolated development project. Do not use real member data.

1. Publish a future month with A/B/C duties, a combined weekend, split weekend,
   special date and secondary cover. Record version/points and retain an unrelated
   edited draft. Verify Swap Requests is absent when no visible requests exist.
2. A drags their own future duty X onto B's Y on desktop. Confirm both dates and
   engineers, add an explanation, then Cancel: no request or schedule change.
   Repeat, Confirm Request, refresh: A sees Awaiting Engineer, B sees Accept/Decline,
   and admin sees no approval action. Today's/past duties and non-owned drag sources
   are ineligible. Try mobile long press, native scrolling and Escape/keyboard
   two-date selection; real-device behavior needs a physical phone check.
3. B declines: A sees Declined, assignments unchanged. Request again, B accepts:
   A sees Awaiting Admin, admin sees Approve/Reject, and B's consent action disappears.
   Admin rejects: A sees Rejected, assignments unchanged. Test A cancelling in both
   pending stages. Switch calendar months: actionable requests remain visible.
4. A requests X/Y again and B accepts. Before admin approves it, C requests their Z
   with B's Y, B accepts and admin approves C's request. A's original request now
   targets C, returns to Awaiting Engineer and disappears from B's incoming list and
   admin's approval list. C explicitly accepts; only then can admin approve A's
   request. Verify X/Y current owners, a new version, unchanged secondary cover,
   points/spans/draft and all earlier versions. Unrelated publication changes must
   keep consent; reassignment of A's source duty must show Invalidated.
5. From two profiles act on the same revision concurrently: only one resolution
   commits, the other must refresh. Test approval before consent via RPC, another
   engineer's consent attempt, inactive/pending users, second weekends, duplicate
   emergency roles, conflicts requiring audited override and deleted/live versions.
   Use `access.sql`, `swaps.sql` and the local-container race test for DB enforcement;
   browser mock checks do not prove database RLS or real Google authentication.
