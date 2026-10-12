# Supabase setup

Frankfurt Production: `hpszwgnwxtxyxpcaivgj`, `eu-central-1`, **Duty Scheduler**,
live at `https://duty-scheduler-two.vercel.app` with the owner's Google admin account.
Independent Frankfurt Development: `qhndiuahuxczujxxitsm`, **Duty Scheduler Dev**,
initialized with no users or operational data; its separate Google client is pending.
Both Tokyo projects are paused and retained. Localhost and Vercel Development/Preview
use only Frankfurt Development; the stable develop alias awaits firewall approval.
See [deployment checkpoint](DEPLOYMENT.md) for exact status and Google origins.
Native Next.js needs only a project URL and publishable key; no service-role key.
The [canonical database architecture](../supabase/README.md) installs the two clean
baseline migrations plus required reference rows, without operational data.

## 1. Create the Google OAuth client

Follow [Supabase's current Google setup](https://supabase.com/docs/guides/auth/social-login/auth-google).

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create or select a project, such as **Duty Scheduler**.
2. Open **Google Auth Platform** and configure the app branding/contact details. Choose an audience that allows the team's Google accounts. For a testing app, add your Google email under **Audience → Test users**; add teammates when ready.
3. Under **Data Access**, use only `openid`, `userinfo.email` and `userinfo.profile`.
4. Under **Clients**, create the **Production** OAuth client of type **Web application**
   with these values. Development needs a separate client and its own Frankfurt
   callback; use the deployment checkpoint once its project is created.

| Setting | Value |
|---|---|
| Authorized JavaScript origin | `https://duty-scheduler-two.vercel.app` |
| Authorized redirect URI | `https://hpszwgnwxtxyxpcaivgj.supabase.co/auth/v1/callback` |

## 2. Configure Supabase

In **Authentication → Sign In / Providers → Google**, enable Google and enter the client ID and secret from Google Cloud. Enter the secret only in Supabase, never in this repository or chat.

In **Authentication → URL Configuration** set:

| Setting | Value |
|---|---|
| Production Site URL | `https://duty-scheduler-two.vercel.app` |
| Production allowed redirect URL | `https://duty-scheduler-two.vercel.app/` |

Temporarily add the protected Production verification origin and return documented
in the deployment checkpoint. Development uses its own URLs and includes localhost;
these are never added to Production.

## 3. First login and explicit admin promotion

After both dashboards are configured, open the app and choose **Continue with Google**. Supabase creates the real login identity; the app creates a pending engineer profile using the Google display name. Nothing is generated or assigned automatically.

The first account is **not** automatically made admin. Confirm the environment/project and the owner's actual `auth.users.id`, then execute [the operator-only first-admin script](../supabase/admin/promote-first-admin.sql). It verifies the exact confirmed Google identity and pending profile, refuses an existing admin, and atomically promotes the row and increments `duty_workspace.revision` under its lock. There is no email reservation table. Reloading or **Check approval** then enters the workspace.

Approved admins can approve later join requests and change approved members' roles in **Team & fairness**. Multiple admins are supported, and at least one active approved admin must remain. Every admin can also receive duties. Approved people can change their own display name through their avatar; subsequent logins do not overwrite it.

Use the exact environment origins in the deployment checkpoint. Production and
Development require distinct callbacks and separate clients. Retire the temporary
Production verification origin after successful cutover; keep localhost confined
to Development.

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

The [browser regression baseline](../README.md#browser-and-visual-regression-baseline)
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

Fresh projects use only the two generated baseline migrations documented in
[database architecture](../supabase/README.md). Historical migrations are archived
outside active CLI discovery. Tokyo's already-applied history remains unchanged;
never push the replacement history or run a reset there.

`supabase/tests/access.sql` creates synthetic auth/member records inside one transaction and rolls everything back; it sends no email and refuses to run on a project with real members. Use an empty development project after real onboarding begins. Checks cover explicit first-admin promotion, multiple admins, last-admin protection, FK values, own-name edits, private notes, stale revisions, publication versions, stable points, boundary-weekend restores, deletion and deactivation.

The clean Frankfurt target matches local application catalog fingerprints and
reports no security-advisor findings. Informational unused-index notices are normal
before real users join. Synthetic tests must run on empty disposable local/Development
databases; Production validation uses schema/catalog/permission checks only.

```sh
node --test tests/*.test.mjs
pnpm exec tsc --noEmit
pnpm build
```

## Local development with the separate development project

1. Copy `.env.example` to `.env.local` at the repository root. Set
   `SUPABASE_URL` to the approved development project's URL and `SUPABASE_PUBLISHABLE_KEY`
   to its publishable key (`sb_publishable_...`), available in the Supabase
   project's Connect dialog / API Keys settings. Do not use an anon JWT,
   secret/service-role key or Google client secret. Fill these in locally only;
   `.env.local` is ignored by Git.
2. In development Supabase **Authentication → URL Configuration**, add
   `http://localhost:5173/` to **Redirect URLs**. Keep the deployed application URL and
   existing redirect entries. If you use another hostname or port, add its
   exact origin with a trailing slash instead.
3. In the separate development Google OAuth web client, add `http://localhost:5173` under
   **Authorized JavaScript origins**. Keep the hosted Supabase callback
   `https://<DEV_REF>.supabase.co/auth/v1/callback` under
   **Authorized redirect URIs**; the database/Auth service is still hosted,
   so no localhost Supabase callback or local Google secret is needed. Ensure
   Google is enabled in Supabase and your account is an allowed test user if
   the Google app is in testing. See [Google setup](https://supabase.com/docs/guides/auth/social-login/auth-google).
4. Restart `pnpm dev` and open `http://localhost:5173`. In browser DevTools,
   confirm `/api/config` returns **200** and the new Frankfurt Development ref
   (do not copy its response into logs or chat), then choose **Continue with Google**
   using your real Development account; do not create hosted bootstrap test accounts.
   Confirm the redirect returns to localhost and your development workspace opens;
   pending accounts still require manager approval. Reload to verify the session
   persists. Use the same hostname throughout the login flow.

`/api/config` returns **503** when its URL is missing or its key is missing or
does not begin with `sb_publishable_`. Native Next.js loads `.env.local`; no
`NEXT_PUBLIC_` prefix is needed. The route reads the server environment per request
and returns `Cache-Control: no-store` for both success and errors. Restart after
changing local configuration. See [Next.js environment variables](https://nextjs.org/docs/app/guides/environment-variables).

For eventual Vercel hosting, select the standard Next.js preset and configure
`SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` as server environment variables.
Use Node 24 and set `ENABLE_EXPERIMENTAL_COREPACK=1` to select the pinned pnpm version.
Google secrets stay in Supabase. Follow the authorized readiness gates in the
deployment checkpoint before cutover. Keep legitimate Preview access protection.

Local login uses the independent Frankfurt Development identity.
Do not configure localhost against production or add local redirects to its client.
The app has no demo login or local-data fallback.

Push notifications, calendar subscriptions and full action audit logs remain future work. Real Google OAuth must be checked after provider setup; database role tests do not replace that check.

## Published duty swaps: migration and verification

The canonical baseline already contains the final consent/reassignment model and
all RPC signatures, including
`duty_request_swap(p_from uuid,p_to uuid,p_explanation text,p_revision bigint)`.
The archived v1/v2 files remain solely for historical upgrade verification. Do not
apply them to a new installation in addition to the baseline. Checked operations
require approved active membership and the last accepted revision.

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

Requires Docker Desktop and pnpm. The CLI database-only mode includes real
Supabase-managed schemas/roles and applies application migrations without starting
Studio/Auth/API services. No hosted credentials or external `psql` client are needed:

```powershell
pnpm dlx supabase@2.119.0 db start
node scripts/database-baseline.mjs --verify-local supabase_db_duty-scheduler
docker cp supabase/tests supabase_db_duty-scheduler:/tmp/duty-tests
docker cp supabase/archive supabase_db_duty-scheduler:/tmp/archive
docker exec supabase_db_duty-scheduler psql -U postgres -q -v ON_ERROR_STOP=1 -f /tmp/duty-tests/access.sql
docker exec supabase_db_duty-scheduler psql -U postgres -q -v ON_ERROR_STOP=1 -f /tmp/duty-tests/swaps.sql
docker exec supabase_db_duty-scheduler psql -U postgres -q -v ON_ERROR_STOP=1 -f /tmp/duty-tests/swap-upgrade.sql
node supabase/tests/first-admin.mjs supabase_db_duty-scheduler
node supabase/tests/swap-races.mjs supabase_db_duty-scheduler
pnpm dlx supabase@2.119.0 stop --project-id duty-scheduler --no-backup
```

These are LOCAL commands. Never pass `--linked`, a hosted URL or hosted credentials.
For full local services use `supabase start`; Next.js still runs on port 5173.
On Windows, if Docker cannot bind the default ports, copy config/migrations to a
disposable work directory, assign available API/DB/shadow/Studio/mail ports there
(e.g. 58321/58322/58320/58323/58324), change the local project ID and use its actual
`supabase_db_<id>` container. Keep hosted project links out of that directory.
`tests/schema.sql` must pass before onboarding/fixtures. The canonical verification
builds application objects in temporary LOCAL schemas, compares catalog/permission
fingerprints and required rows with migration replay, then drops those test schemas.
The first-admin test executes the actual operator script with invented Google identities,
checks caller/identity/refusal gates, and removes fixtures. Swap race tests create
synthetic fixtures and clean up; reset the local database before reusing clean-install
checks because race tests intentionally increment the workspace revision.

`swap-upgrade.sql` rebuilds the swap feature inside a rollback transaction, then
applies the actual v1/v2 migrations with synthetic historical resolutions and
duplicate pending rows. It verifies unchanged audit/history data and fresh consent.
`swap-races.mjs` uses two real PostgreSQL connections for approve/approve,
approve/cancel and consent/reassignment races, creates only synthetic fixtures in
an empty disposable local container, and cleans them up after each case.

The supported browser regressions are in `tests/browser`; run `pnpm build` and
`pnpm test:e2e:ci` as documented in README. They mock external requests and verify
UI/RPC contracts, not database permissions, Google sign-in or real-device gestures.

### Read-only hosted migration diagnostics

Tokyo retains eight historical versions; new Frankfurt has the two canonical baseline
versions. Do not replay or repair either history blindly. If a schema-cache or RPC error occurs, inspect history and function metadata
in the explicitly identified project before proposing a separately approved fix:

```sql
select version,name from supabase_migrations.schema_migrations order by version;
select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid),p.proargnames,
       has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('duty_request_swap','duty_resolve_swap');
```

History/schema disagreement requires investigation, not blind replay or history
repair. Cache reload cannot create missing functions. Use the clean initialization runbook for new
projects and separately approved incremental migrations for existing environments.
Run the acceptance checks below only in an isolated development project.

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
