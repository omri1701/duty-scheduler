# Supabase setup

Frankfurt Production: **Duty Scheduler**, `hpszwgnwxtxyxpcaivgj`, `eu-central-1`,
`https://duty-scheduler-prod.vercel.app`. Frankfurt Development: **Duty Scheduler
Dev**, `qhndiuahuxczujxxitsm`, `eu-central-1`,
`https://duty-scheduler-dev.vercel.app`. Accounts, OAuth configuration and data stay
separate. See [release workflow](DEPLOYMENT.md) for database-first CI/CD, scoped
credentials, Production approval and recovery. Never reset these hosted projects.
Native Next.js needs only a project URL and publishable key; no service-role key.
The [canonical database architecture](../supabase/README.md) installs the two clean
baseline migrations plus required reference rows, without operational data.

## Unmerged migrations in local development

`pnpm dev` connects to hosted **DEV**; it does not apply branch migrations there.
Use `pnpm dev:local` to test unmerged database features. It runs the same setup as
`pnpm local:setup`: starts the separate LOCAL stack and applies pending incremental
migrations with `supabase migration up --local`, preserving existing local data.
Stop the existing development server before starting another on port 5173. Check
`/api/config`'s Supabase URL and the environment badge to verify the actual target.

A missing `duty_cancel_draft(p_month text, p_revision bigint)` RPC on hosted DEV
means its incremental migration has not been released there; local setup cannot
change a hosted database. Follow the approved [database-first release](DEPLOYMENT.md)
after merge. Do not push feature migrations to hosted environments or reset them.
The calendar changes require both `20261017185214_cancel_month_draft.sql` and
`20261017211958_today_inclusive_published_swaps.sql`. A hosted database with only
the two baseline migrations supports neither the new cancellation RPC nor the
today-inclusive swap behavior. After explicit approval to merge and migrate hosted DEV, merge
the reviewed PR into `develop`; its exact-head Quality run invokes the
Development release: dry-run/push pending migrations, verify history and database
contract, then deploy the matching app. Inspect that run's database and deployment
results before testing hosted DEV. Do not run a feature-branch hosted migration
push separately; see [release and retry details](DEPLOYMENT.md#development-and-production).
If the function exists, verify authenticated EXECUTE grants and the PostgREST
schema cache before changing the client. Never restore drafts from client data.

`pnpm exec node supabase/tests/calendar-rpc.mjs` verifies Cancel Draft through real
LOCAL Auth/PostgREST, including manager grants, exact parameter discovery,
December/January ownership, revision races and transactional failure rollback.
It requires unused synthetic far-future months, cleans only its own fixtures and
refuses hosted API targets. The disposable SQL suite also checks Israel-midnight
swap eligibility with a transaction-local frozen clock and rolls everything back.

With `pnpm dev:local` running, `pnpm test:runtime:local` checks the real served
app through local password Auth and PostgREST, without backend interception. It
checks desktop 1024/1280/1440px and iPhone WebKit 375/390/430px in both languages,
CSS source fingerprints, computed toolbar layout, real Chromium tab zoom at
100/125/150/200%, the popup menu, ordinary reload and fresh
browser sessions. Captures and computed evidence go to
`work/runtime-investigation/corrected`. Add `-- --exercise-cancel` to exercise
cancellation on the current synthetic LOCAL month: it publishes if necessary,
regenerates, cancels through the browser, verifies restored assignments/status
and preserved history/other assignments, verifies New/Published/Reopened states
at all widths/zooms and leaves a reopened draft for review.
This optional write test refuses hosted targets and non-synthetic members. With
only the two default local members, it fills uncovered duties through the checked
schedule RPC before the initial publication; it does not relax scheduling rules.

## 1. Create the Google OAuth client

Follow [Supabase's current Google setup](https://supabase.com/docs/guides/auth/social-login/auth-google).

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create or select a project, such as **Duty Scheduler**.
2. Open **Google Auth Platform** and configure the app branding/contact details. Choose an audience that allows the team's Google accounts. For a testing app, add your Google email under **Audience → Test users**; add teammates when ready.
3. Under **Data Access**, use only `openid`, `userinfo.email` and `userinfo.profile`.
4. Under **Clients**, create the **Production** OAuth client of type **Web application**
   with these values. Development needs a separate client and its own Frankfurt
   callback `https://qhndiuahuxczujxxitsm.supabase.co/auth/v1/callback` and
   origin `https://duty-scheduler-dev.vercel.app`.

| Setting | Value |
|---|---|
| Authorized JavaScript origin | `https://duty-scheduler-prod.vercel.app` |
| Authorized redirect URI | `https://hpszwgnwxtxyxpcaivgj.supabase.co/auth/v1/callback` |

## 2. Configure Supabase

In **Authentication → Sign In / Providers → Google**, enable Google and enter the client ID and secret from Google Cloud. Enter the secret only in Supabase, never in this repository or chat.

In **Authentication → URL Configuration** set:

| Setting | Value |
|---|---|
| Production Site URL | `https://duty-scheduler-prod.vercel.app` |
| Production allowed redirect URL | `https://duty-scheduler-prod.vercel.app/` |

Development uses `https://duty-scheduler-dev.vercel.app` and its exact trailing-slash
return, plus localhost. These are never added to Production.

## 3. First login and explicit admin promotion

After both dashboards are configured, open the app and choose **Continue with Google**. Supabase creates the real login identity; the app creates a pending engineer profile using the Google display name. Nothing is generated or assigned automatically.

Each explicit **Continue with Google** requests account selection (`prompt=select_account`), including when Google remembers only one account, so users can choose an existing account or **Use another account**. Returning authenticated users restore their Duty session without Google OAuth. Signing out clears the Duty session without signing out of Google; choosing a different account still requires that identity's own membership approval.

The first account is **not** automatically made admin. Confirm the environment/project and the owner's actual `auth.users.id`, then execute [the operator-only first-admin script](../supabase/admin/promote-first-admin.sql). It verifies the exact confirmed Google identity and pending profile, refuses an existing admin, and atomically promotes the row and increments `duty_workspace.revision` under its lock. There is no email reservation table. Reloading or **Check approval** then enters the workspace.

Approved admins can approve later join requests and change approved members' roles in **Team & fairness**. Multiple admins are supported, and at least one active approved admin must remain. Every admin can also receive duties. Approved people can change their own display name through their avatar; subsequent logins do not overwrite it.

Use the exact environment origins above. Production and Development require
distinct callbacks and separate clients; keep localhost confined to Development.

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

New publications contain only duties owned by that month: weekdays by date and both
weekend halves by Friday, including a split/special Saturday in the next month.
`duty_cancel_draft(p_month, p_revision)` is separate from historical version restoration.
It requires an active approved manager, takes the existing workspace revision lock,
reads the current publication pointer, verifies owned coverage, and replaces only
that owner's working rows in one transaction. It restores Published status without
changing the pointer, sequence, history, requests, membership, availability, or any
other month's rows/status. Missing coverage or a conflicting boundary row rejects
the entire operation. The client sends no restoration rows or publication ID.

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

Fresh projects replay the two frozen baseline migrations and subsequent incremental migrations documented in
[database architecture](../supabase/README.md). Historical migrations are archived
outside active CLI discovery. Tokyo's already-applied history remains unchanged;
never push the replacement history or run a reset there.

`supabase/tests/access.sql` creates synthetic auth/member records inside one transaction and rolls everything back; it sends no email and refuses to run on a project with real members. Use an empty development project after real onboarding begins. Checks cover explicit first-admin promotion, multiple admins, last-admin protection, FK values, own-name edits, private notes, stale revisions, publication versions, stable points, boundary-weekend restores, deletion and deactivation.

Both Frankfurt catalogs match the local schema/permission fingerprints. Synthetic
tests must run on empty disposable local databases; hosted release validation uses
read-only schema/catalog/permission and static-reference checks only.

```sh
node --test tests/*.test.mjs
pnpm exec tsc --noEmit
pnpm build
```

## Localhost environment selector

Stop the running Next server before switching. All commands use native Next.js on
`http://localhost:5173`, bind to loopback, and never rewrite `.env.local` or run
hosted migrations. `pnpm dev` / `pnpm dev:dev` default to Frankfurt Development;
`pnpm dev:select` optionally prompts for a target.

| Command | Target / behavior |
|---|---|
| `pnpm dev:local` | Starts the isolated Docker Auth/API database, applies current-branch migrations, prepares test accounts, then starts Next. |
| `pnpm dev:dev` | Existing Development URL/public key from `.env.local`, optionally `.env.dev.local`, or shell environment. Normal checked writes and Google login. |
| `pnpm dev:prod` | Production public key from ignored `.env.prod.local` (`SUPABASE_PROD_PUBLISHABLE_KEY=sb_publishable_...`) or the same shell variable. Type `INSPECT PRODUCTION` each run in an interactive terminal. URL is fixed to the existing Frankfurt Production project. |
| `pnpm local:setup` | Starts/prepares and verifies local Auth, onboarding, workspace reads and denied direct table writes without starting Next. |
| `pnpm local:reset` | **Discards only the isolated local app database**, replays the current branch and recreates synthetic accounts. Use after incompatible branch migration changes or to restore pending fixtures. |

LOCAL requires Docker Desktop and the pinned CLI (`pnpm dlx supabase@2.119.0`).
It uses ignored `work/local-supabase`, project `duty-scheduler-app`, ports
58320?58324, and container `supabase_db_duty-scheduler-app`. This stack is separate
from Quality's empty `duty-scheduler` SQL-test database. Auth/API/Studio/mail run;
unneeded analytics, pooling, Realtime, Storage and Edge services are excluded.
No hosted links, service-role keys, Google secrets or live data are copied.
The disposable migration copy is refreshed from the current branch; migration
hashes reject removed/edited previously applied files until an explicit local
reset. Pending incremental migrations are applied with `migration up --local`.

Local sign-in uses the real Supabase password Auth service, checked `duty_join`
and unchanged RLS. Local email confirmation is disabled only in CLI config;
hosted Google authentication and identity checks stay unchanged. Accounts:
`admin@duty.local` (approved admin), `engineer@duty.local` (approved engineer),
`pending@duty.local` (pending on fresh setup/reset). Their **local-only** password
is `Duty-local-only-1701!`. Operator approval of the two fixtures runs only inside
the exact local Docker container. No browser bypass or hosted bootstrap exists.
You can approve the pending account normally; setup preserves that later approval.
The fixtures do not create schedules. Sessions and PKCE verifiers use separate
storage keys per actual Supabase URL/port; switching targets cannot reuse another
project's session. Existing pre-selector sessions require a new login once.

Badges appear on login and workspace: LOCAL blue, DEV green on localhost and
`duty-scheduler-dev.vercel.app`, and PROD red only for localhost Production.
Deployed Production has no badge. Text contrasts against pastel backgrounds and
both EN/HE layouts work on mobile. The URL/project and runtime origin determine
the badge and policy. Unknown projects, URL paths/credentials, mode mismatches,
wrong hosted origins and unconfirmed localhost Production return a no-store 503.
Authorized Vercel deployment URLs use the server-supplied Vercel URL and
validated hosting scope: previews remain DEV; immutable Production URLs have no
badge. The known Development/Production aliases cannot swap projects.
The browser-container QA origin `host.docker.internal` accepts DEV only.
Local CLI anon JWTs are accepted only for loopback targets when their decoded
role is `anon` and issuer is `supabase-demo`; secret/service-role keys are rejected.
Supabase still verifies keys/tokens and enforces RLS.

Production inspection blocks automatic `duty_join`, all mutating RPCs (including
future/unknown RPC names), direct table writes and Auth signup/profile writes in
the central application transport. Editing, approvals, swaps and profile saves
are disabled; reading, navigation, history previews and sign-out remain available.
**This is application-level protection, not database-enforced read-only access.**
An approved member's Supabase token retains its existing database privileges;
a separate client can still write under the hosted permissions. Never use this
mode to test writes or unmerged schemas. There is no write-enable switch.
Use an **existing Production Google identity only**: OAuth authentication may
create/update an Auth identity when hosted provider signups are enabled, and
login/token refresh necessarily writes Auth session state. The app cannot prevent
provider-side signup without changing hosted Auth settings. Inspection sign-out
revokes only its own session, preserving other deployed/mobile sessions.

Production keeps its existing Google redirects; no localhost redirect is added.
For localhost inspection, Continue with Google opens a new tab and returns to
`https://duty-scheduler-prod.vercel.app/?code=...`. Copy that return URL into the
localhost login form promptly and submit. The one-time code is exchanged only
with the originating localhost PKCE verifier, without copying access/refresh
tokens. The deployed page may show a missing-verifier login error: the verifier
belongs to localhost. Close that tab after completing login. Only existing
approved members can enter; unapproved/non-member accounts do not create join
requests. Do not share/log callback URLs. This handoff has synthetic regression
coverage; live Google/provider behavior still needs an operator check.

If startup fails, inspect Docker Desktop and port availability. CLI diagnostics
must stay local (CLI output can contain keys):

```sh
pnpm dlx supabase@2.119.0 start --exclude logflare,vector,supavisor,edge-runtime,imgproxy,storage-api,realtime --workdir work/local-supabase
pnpm dlx supabase@2.119.0 stop --workdir work/local-supabase
```

## Local development with the separate development project

These steps apply to feature branches too. Keep the existing `.env.local` on
Frankfurt Development (`qhndiuahuxczujxxitsm`); switching Git branches does not
select a different database. Unmerged migrations and their tests run only against
disposable local Supabase. If a feature needs a schema not yet deployed to shared
Development, use local app configuration for that test; never push its SQL to the
hosted project. See [intentional manual previews](DEPLOYMENT.md#feature-branches-localhost-and-intentional-previews).

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
is invalid for the validated project/origin (hosted keys must be `sb_publishable_...`). Native Next.js loads `.env.local`; no
`NEXT_PUBLIC_` prefix is needed. The route reads the server environment per request
and returns `Cache-Control: no-store` for both success and errors. Restart after
changing local configuration. See [Next.js environment variables](https://nextjs.org/docs/app/guides/environment-variables).

### iPhone Safari through a static ngrok development domain

Install the Windows agent from [ngrok](https://ngrok.com/download/windows), or put
the standalone executable in ignored `work/ngrok/ngrok.exe`. Authenticate only in
your local PowerShell terminal: `powershell -NoProfile -ExecutionPolicy Bypass -File
scripts/ngrok-auth.ps1`. It prompts for the token without echoing it or putting it
in shell history, and stores it in ignored `work/ngrok/ngrok.yml`. A new config
uses `version: 3` and `agent.web_addr: false`; request inspection stays disabled.
Never paste the token into chat or commit the config.

Set `DUTY_DEV_ORIGIN=https://<your-assigned-static-domain>` in ignored
`.env.dev.local`. Use the free assigned domain from the ngrok dashboard, with no
path, query, wildcard or nonstandard port. Run `pnpm dev:mobile`; it uses the
existing `dev:dev` launcher, waits for DEV `/api/config`, then tunnels only
`http://localhost:5173`. Next.js remains bound to `127.0.0.1`. Ctrl+C stops both
process trees. Keep Windows awake and the command running for IntelliJ hot reload.

Manually add the exact `https://<your-assigned-static-domain>/` (trailing slash)
to **Redirect URLs** in Frankfurt DEV (`qhndiuahuxczujxxitsm`). Keep its Site URL
and existing entries. The current redirect flow does not require Google's browser
SDK or a new JavaScript origin. If following Supabase's recommended Google client
setup, add `https://<your-assigned-static-domain>` (no slash) to the separate DEV
client's **Authorized JavaScript origins**. The Google authorized redirect URI
stays `https://qhndiuahuxczujxxitsm.supabase.co/auth/v1/callback`.
The app uses the Supabase OAuth redirect flow, rather than Google's browser SDK;
the Supabase redirect allowlist is what controls the return to this app.
Do not add the tunnel as a Google redirect URI or change Production settings.

Open the exact HTTPS URL in ordinary iPhone Safari, pass ngrok's free browser
interstitial if shown, and confirm the DEV badge. Choose **Continue with Google**
and return to that same origin. Reload, then close/reopen the tab to verify session
persistence. PKCE verifiers and sessions stay in Safari storage for that origin;
starting on localhost or changing browsers cannot complete the same PKCE flow.
This requires a real iPhone check; automated configuration checks do not prove OAuth.

The tunnel exception requires `next dev`, the explicit DEV launcher target and
Frankfurt DEV URL, and is disabled on Vercel and production builds. Only the
configured ngrok hostname is added to Next.js `allowedDevOrigins`; application
environment resolution still checks the exact HTTPS origin and DEV project.
No database permissions or session verification rules change.

For Vercel hosting, retain the standard Next.js preset and configure
`SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` as server environment variables.
Use Node 24 and set `ENABLE_EXPERIMENTAL_COREPACK=1` to select the pinned pnpm version.
Google secrets stay in Supabase. Follow the Environment/approval gates in the
[release workflow](DEPLOYMENT.md). Keep legitimate Preview access protection.

Local login uses the independent Frankfurt Development identity.
Use Production on localhost only through the confirmed inspection selector above;
never add local redirects to its client. LOCAL uses isolated Supabase Auth/data,
with no demo bypass or browser-local fallback.

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
explicit admin override reason at approval. Published swap requests retain their
weekend cap: a swap cannot increase an engineer's weekend count above one. Draft
swaps can instead explicitly approve weekend exceptions in the manager dialog. Secondary
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
