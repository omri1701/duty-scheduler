# Development and production deployment

This is an approval-gated runbook. Repository preparation does not authorize
merges, resource creation, remote SQL, environment/integration changes or deployment.

## Architecture and verified baseline (2026-10-10)

| Environment | Git branch / Vercel target | Supabase | Google OAuth / data |
|---|---|---|---|
| Production | `master` / Production | Existing `ukxxpbivgxyxharhxgqf` | Preserve production client; approved users and real schedules |
| Development | `develop` and feature PRs / Preview | New independent Free project | Separate development client; dedicated test accounts and synthetic schedules |
| Local | Feature checkout / `localhost:5173` | Development project or disposable local stack | Development client only; synthetic data |

GitHub API and fetched refs confirm public repository `omri1701/duty-scheduler`,
default `develop`, merged PRs #2–#9 into `develop`, and open, mergeable PR #1
(`develop` → `master`). At audit, `master` (`d680a5a`) is an ancestor of `develop`
(`957e53c`), 30 commits behind. Both branches are unprotected (GitHub branch API).
PR #1's original description/validation is stale;
review its current full diff and final head before release.

Authenticated Supabase metadata confirms organization `omri1701`
(`vaplnkaubzopjbixlxng`) is Free, production is healthy, CPR is inactive, and all
eight committed migration versions are recorded in production. History is not
proof of schema equality. No production user data was read or copied.

The project-creation cost quote is $0/month. [Free billing rules](https://supabase.com/docs/guides/platform/billing-on-supabase)
allow two active projects across organizations where the account is owner/admin;
paused projects do not count. A development slot appears available; recheck quota
and quote immediately before creation and obtain approval. Leave CPR untouched;
do not restore, delete or repurpose it. [Free limits](https://supabase.com/pricing)
include inactivity pausing and no automatic backups/SLA; monitor both projects
and retain secure, owner-managed production backups outside Git.

Vercel Production following `develop`, production variables formerly shared with
Preview, integration scopes and Google configuration are owner-reported, not
verified by authenticated tools. Record project/team, live deployment ID/SHA,
production domains, actual branch, variable scopes/branch overrides and both
integration settings in the dashboards before rollout. Never record secret values.

## Vercel configuration

Keep one existing Vercel project, native Next.js preset, Node 24, `pnpm build`,
default install/output settings and the package-manager version in `package.json`.
No paid custom environment or Supabase branching is needed.

| Variable | Production | Preview (all branches) | Development / `.env.local` |
|---|---|---|---|
| `SUPABASE_URL` | `https://ukxxpbivgxyxharhxgqf.supabase.co` | `https://<DEV_REF>.supabase.co` | Development URL |
| `SUPABASE_PUBLISHABLE_KEY` | Matching production publishable key | Matching development publishable key | Development publishable key |
| `ENABLE_EXPERIMENTAL_COREPACK` | `1` | `1` | `1` for Vercel builds; unnecessary locally |

Remove Production+Preview shared values and every Preview branch override pointing
to production. Until development is ready, Preview/Development application
variables should be absent (the app fails configuration with HTTP 503).
Keep Supabase→Vercel production sync ON only after verifying it writes the exact
two names above to Production only; keep Preview/Development sync OFF. If it
manages other names, keep a single explicit owner for each application variable.
Keep Supabase GitHub **Deploy to production OFF**; verify its production branch
mapping before any future activation. Leave paid automatic branching OFF.

Environment edits affect new deployments; old Previews retain their configuration.
Inventory and remove or block historical Previews that use production, including
their branch aliases. With separate approval, audit production Supabase redirects
and Google origins: remove Preview/localhost entries and broad Vercel wildcards,
preserving required production origins/callbacks. Verify production Auth never
returns to a Preview origin using authorization redirect inspection without
completing sign-in (a disallowed redirect may fall back to the production Site URL).
Browser sessions can retain already-fetched public config;
blocking a deployment does not revoke a previously issued production session.
The publishable key is public and RLS/RPC checks remain mandatory. If approved
production users signed into unsafe Previews, obtain approval for targeted session
revocation and incident review; removing environment values alone is insufficient.

`vercel.json` suppresses automatic Git deployments only for the preparation branch
`chore/environment-separation`, preventing this PR from using inherited credentials.
Other branches retain Vercel defaults. This is not general environment enforcement;
verify the Vercel result after push. Do not manually deploy this branch.

## Initialize development (after explicit approval)

1. Reconfirm $0 cost/quota, create **Duty Scheduler Development** in `omri1701`
   with no paid add-ons, and record its distinct ref. Do not clone production,
   import a dump, restore a backup or synchronize `auth.users`, notes or schedules.
2. Use an isolated temporary work directory with only committed migrations copied
   into `supabase/migrations`. Initialize CLI config there, inspect current CLI
   `link`, `migration list` and `db push --help`, then link explicitly to the
   approved development ref. Stop if it equals production, CPR, or is not the
   recorded development ref. Confirm an empty application/auth database and empty
   migration history. Never reuse a cached production link or reset a linked DB.
3. Inspect `db push --dry-run` against that explicit development link, then apply
   the eight files once in ascending version order. Do not repair history to mask
   failures; stop and investigate a mismatch. CLI execution records migration history.

| Order | Version / contract |
|---|---|
| 1 | `20260917214435` initial workspace, auth FKs, RLS and checked RPCs |
| 2 | `20260917214658` qualified special overlap |
| 3 | `20260917215057` month-boundary publication behavior |
| 4 | `20260918132734` domain FKs and versioned duty rows; **requires empty schedules** |
| 5 | `20260918133756` publication-pointer index |
| 6 | `20260918133851` index column order |
| 7 | `20261009145431` published swap requests |
| 8 | `20261009161959` counterpart consent/reassignment and schema reload |

The audit replayed all eight migrations on disposable local Supabase/Postgres 17;
all four existing database regressions passed. Eleven public RPC argument/grant
contracts and RLS on every public duty table matched expectations; synthetic users
were removed and the stack stopped. Hosted schema/OAuth remain separate checks.

Historical consolidation intentionally refuses existing schedules. Its drops are
valid on fresh initialization; never replay it on production or a populated dev DB.
Do not rewrite migrations. OAuth settings, secrets and admin promotion are not
installed by migrations. Standard Supabase `auth` schema/roles are prerequisites.

4. Verify all eight history entries and RPC names/argument names against
   `lib/supabase/rpc.ts`, authenticated execute grants and RLS on exposed tables.
   Run the existing `access.sql`, `swaps.sql`, `swap-upgrade.sql` and
   `swap-races.mjs` first on the empty disposable local stack described in
   [Supabase setup](SUPABASE_SETUP.md#empty-local-supabase-database-powershell).
   These exercise pending/inactive users, private notes, admin/approval protection,
   revision conflicts, immutable publications and swap consent. They must never
   run on production or a project with members. Local tests do not certify hosted RLS.
5. Configure development OAuth below, sign in with dedicated Google test accounts,
   and explicitly promote the verified first development admin as described in
   Supabase setup (including revision increment). Use invented display names,
   notes and schedules only; Google OAuth itself uses real test-account identities.

## Independent Google OAuth

Prefer a separate Google Cloud project **Duty Scheduler Development**, with a
Web application client in Testing and only dedicated test accounts in its audience.
Use only `openid`, `userinfo.email`, `userinfo.profile`; enable no billable APIs.
Store its client ID/secret in the development Supabase Google provider only.

| Setting | Development value |
|---|---|
| Google authorized redirect URI | `https://<DEV_REF>.supabase.co/auth/v1/callback` |
| Google JavaScript origins | Exact stable develop Preview origin and `http://localhost:5173` |
| Supabase Site URL | Stable develop Preview origin |
| Supabase allowed redirects | `https://<exact-develop-preview-host>/` and `http://localhost:5173/` |

Obtain the real branch Preview host from Vercel; do not guess its generated name.
Before cutover, `develop` still deploys to Production. Bootstrap development OAuth
with localhost as Site URL and/or an explicitly approved feature Preview after
Preview variables are isolated; allow only those exact return URLs. Set the final
stable develop Preview Site URL/origin once cutover makes that branch a Preview.
Add exact feature-preview URLs only when OAuth testing there is needed; remove
obsolete entries. Avoid `https://**.vercel.app/**` or other broad wildcards. Ordinary
PRs can use synthetic Playwright auth. Supabase callback URI and app return URL
are different: the app uses PKCE with `window.location.origin + '/'`.
Production retains its current Google client, callback, Site URL and required exact
production app redirects. Retire unsafe Preview/local redirects only with approval
as above. Changing only the Git branch does not require changing production URLs.
Smoke-test development sign-in, denial, return to the same origin, reload/refresh,
sign-out, pending approval and two-session stale revisions before release.

## Exact transition and releases (approval required)

1. Freeze pushes/merges to `develop` while it still drives production. Record the
   current healthy deployment/SHA and domain mapping for rollback. Verify dashboard
   baseline, backup availability and production auth without changing settings.
2. With approval, isolate Preview variables and retire unsafe historical Previews
   as above, leaving current Production running. Initialize/verify development and
   its independent OAuth at localhost or an approved feature Preview; `develop`
   remains Production until step 6. Do not merge the preparation PR before isolation.
3. Review and explicitly approve merging the preparation PR into `develop`.
   Because production still follows `develop`, this may rebuild production; verify
   its healthy deployment and final SHA. Quality now gates both `develop` and `master`.
4. Refresh PR #1's title/body around the complete native Next.js release. Require
   a successful Quality run on its final head/test merge, compare ancestry again,
   confirm all required production migrations already exist and freeze the head.
   Do not merge until separately approved. No production database change is
   required for this audited release; if drift is found, stop for a separate plan.
5. After approval, merge PR #1 with a **merge commit**, preserving `develop`
   ancestry (no squash/rebase, force push or branch replacement). Keep `develop`.
   Verify the resulting `master` tree equals the reviewed `develop` tree.
6. With approval, change Vercel Production Branch to `master` only now, preserve
   production variables/domains/integration scope, and trigger a fresh Production
   build from that exact `master` commit. Do not promote a dev-configured Preview:
   [promotion retains its environment](https://vercel.com/docs/deployments/promoting-a-deployment).
   The existing healthy deployment stays served until a successful replacement.
7. Verify deployment SHA, `/api/config` project URL (without logging keys), same
   production origin, Google login/return, approval and read-only schedule/history.
   Verify `develop` now creates Preview using the dev ref; finish its exact stable
   development OAuth origin/Site URL and repeat the smoke test. Avoid synthetic writes
   on production. Change GitHub default branch to `master` if desired only now;
   explicitly target feature PRs to `develop`. Unfreeze development after checks.

Protect both branches: require PRs, the actual `quality` check from GitHub Actions,
resolved conversations and up-to-date checks; prohibit force pushes/deletion and
restrict bypasses. Require one independent human approval when another maintainer
is available (a solo owner cannot approve their own PR). Do not require linear
history for `master`: release merge commits preserve shared ancestry. Confirm
available rules and check names before activation; no protection was changed here.

Normal releases: feature PR → `develop`, dev migrations/auth smoke tests, then
reviewed `develop` → `master` merge-commit release with final Quality success.
Never delete `develop` after release. Merge `master` back into `develop` by PR
after releases/hotfixes so ancestry stays synchronized. For future schema changes,
use backward-compatible expand/contract migrations, test in development first,
then separately approve only new production migrations and their release timing.
GitHub/Vercel deployment success does not apply database migrations.

## Automation boundary and rollback

GitHub connector/Git authentication can audit refs/PRs, publish this preparation PR
and verify CI. Supabase connector authentication was verified for metadata and cost;
resource creation and dev migrations can be automated only after specific approval.
Vercel and Google Cloud management authentication is unavailable in this session;
their changes require dashboard work or a separately authenticated approved tool.
No API-billed AI authentication is required or introduced.

On a failed cutover, keep or restore the recorded healthy **Production** deployment
and domain assignment using Vercel's available rollback/redeploy procedure. Never
use a dev Preview artifact as rollback. If needed, separately approve restoring
Production Branch to its recorded value; keep `develop` frozen while it drives
production. Preserve production environment values/OAuth throughout. A branch
setting alone does not roll back the deployment. Use a reviewed revert PR for code;
do not reset/force-push shared history. This rollout has no production SQL rollback.
Keep Preview isolated during rollback; never restore its production credentials.
Development failures can be handled in a newly approved empty dev project without
affecting production or CPR. Future destructive schema changes need a separate
backup/restore plan; Vercel rollback does not roll back Supabase data.
