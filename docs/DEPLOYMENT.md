# Database and application releases

GitHub Actions is the single release orchestrator. Quality uses disposable LOCAL
Supabase only. After it passes, reusable `deploy.yml` applies pending SQL, verifies
the database contract, then deploys the exact application SHA. Normal releases
need no SQL Editor execution. Application behavior and visual snapshots are unchanged.

| Branch | GitHub Environment | Vercel target / domain | Supabase (Frankfurt) |
|---|---|---|---|
| `develop` | Development | Preview / `duty-scheduler-dev.vercel.app` | `qhndiuahuxczujxxitsm` |
| `master` | Production | Production / `duty-scheduler-prod.vercel.app` | `hpszwgnwxtxyxpcaivgj` |

Read-only inspection on 12 October 2026 confirmed both projects are healthy in
`eu-central-1`, PostgreSQL 17, with exactly `20261011212413_clean_baseline` and
`20261011212421_required_reference_data` applied. This CI/CD PR has no real
migration and writes to neither hosted database. Never replay Frankfurt baselines
into Tokyo's archived history or repair history to resemble another environment.

One Vercel project: `prj_Jl2PBhK8DsvK183rKKWesr0821OY`, team
`team_pbvqzViC50aeT2kaRNnTYkPt`. On the free plan a hosted Development app uses
**Preview**; Vercel's **Development** variables are for local `vercel dev`/`env pull`.
Preview and Development variables must both point to Frankfurt Development.
No paid custom environment or additional service is needed.

## Feature branches: localhost and intentional previews

Feature branches may run `pnpm dev` at `http://localhost:5173` using the existing
Git-ignored `.env.local`: `SUPABASE_URL=https://qhndiuahuxczujxxitsm.supabase.co`
and its publishable key. Branch selection never switches this configuration to
Production. Keep Development's localhost OAuth origin/redirect as documented in
[Supabase setup](SUPABASE_SETUP.md#local-development-with-the-separate-development-project).
Normal application/RPC access to shared Development remains subject to existing
approval, RLS and revision checks; it grants no migration permission.

Test new canonical SQL and incremental migrations on disposable LOCAL Supabase,
using the existing `schemas/`, `reference-data/`, `migrations/` and SQL tests.
When the feature requires unapplied database changes, test that path locally with
local URL/key configuration (a separate ignored env file or shell overrides), then
restore the existing Development `.env.local`. Do not copy canonical schemas into
another maintained tree or push unmerged migrations to shared Development.
Only `develop` releases migrate hosted Development; only approved `master` releases
migrate hosted Production. Feature-branch Quality dispatches also remain local-only.

Automatic feature Git deployments stay disabled. For an **intentionally authorized**
manual Preview, first require successful feature Quality checks and compatibility
with the already verified hosted Development schema. An authorized operator can
inspect history read-only with
`pnpm dlx supabase@2.119.0 migration list --project-ref qhndiuahuxczujxxitsm`.
All branch-required migrations must already be applied, with matching history;
otherwise wait for the database-first `develop` release and use a local app meanwhile.
Never run hosted `db push`, reset, seeds or history repair from a feature checkout.

Verify the Vercel **Preview** variables and any feature-branch overrides contain
only the Development URL/publishable key. `.env.local` is excluded from uploads;
manual Preview uses Vercel's Preview configuration, not the local file. From a
clean feature checkout, use the standard CLI (PowerShell):

```powershell
$featureBranch = git branch --show-current
if (-not $featureBranch -or $featureBranch -in @('develop','master')) { throw 'Select the feature branch' }
$featureSha = git rev-parse HEAD
pnpm dlx vercel@62.0.0 link --yes --project duty-scheduler --scope omri1701s-projects
pnpm dlx vercel@62.0.0 pull --yes --environment preview --git-branch "$featureBranch" --scope omri1701s-projects
pnpm dlx vercel@62.0.0 build --scope omri1701s-projects
pnpm dlx vercel@62.0.0 deploy --yes --prebuilt --target preview --scope omri1701s-projects --meta githubDeployment=1 --meta "githubCommitRef=$featureBranch" --meta "githubCommitSha=$featureSha"
```

`pull` writes ignored `.vercel` Preview settings, preserving `.env.local`; the
prebuilt upload uses the standard local Vercel/Next.js build instead of asking the
remote feature-branch build filter to build. Keep the project-wide filter and
automatic Git deployment disablement unchanged.
Keep Vercel Authentication enabled and use the generated feature Preview URL.
Verify `/api/config` points to Development and check sign-in; its exact OAuth return
must be authorized in Development only. Never relabel a feature as `develop`, alias
it onto either stable environment domain, deploy with `--prod`, or enable a Git
deployment hook. CLI previews deploy application code only and do not migrate SQL.
Required database changes therefore complete through the existing release pipeline
before a compatible feature Preview can be released.

## Setup before activation

Create GitHub Environments **Development** and **Production**, with selected
deployment branches `develop` and `master` respectively. Configure these secrets
**separately in each Environment**, never repository-wide or in PR jobs:

| Secret | Value / scope |
|---|---|
| `SUPABASE_DB_URL` | That project's percent-encoded PostgreSQL password URL; direct or Frankfurt session pooler, port 5432, database `postgres`, `?sslmode=require` |
| `SUPABASE_PUBLISHABLE_KEY` | That project's `sb_publishable_...` key |
| `VERCEL_TOKEN` | Deployment token limited to the existing Duty team/project as supported by the account; separate environment tokens |
| `VERCEL_ORG_ID` | `team_pbvqzViC50aeT2kaRNnTYkPt` |
| `VERCEL_PROJECT_ID` | `prj_Jl2PBhK8DsvK183rKKWesr0821OY` |

Copy the actual **session pooler** host from Supabase Connect, e.g.
`postgresql://postgres.<REF>:<ENCODED_PASSWORD>@aws-<N>-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require`.
Do not guess `<N>`. The project-qualified username/host are checked before writes.
Direct IPv6 connections are supported; session pooling avoids IPv6 limitations on
GitHub-hosted runners. Transaction pooling (6543), wrong regions/projects and
plaintext connections fail. No Management API token, service-role key or Google
secret is needed. The database credential is privileged DDL access to **one project**,
not a runtime identity: the postgres-owned baseline needs owner-level DDL. Restrict
it to protected release jobs, rotate it and audit access.

Production has **required reviewer `omri1701`** for explicit deployment approval,
with **Prevent self-review off** so the solo maintainer can approve a run they
initiated. **Admin bypass is disabled**; self-approval remains a deliberate manual
action recorded by GitHub. The gate checks this protection before requesting approval.
Protect both branches with required `quality`, up-to-date checks, enforced admin
protection and no force pushes/deletion. Require PRs with **zero mandatory
third-party approvals**, since GitHub cannot approve the author's own PR. Review
the diff before merging; deployment approval is a separate gate. Production requires
a merged `develop` -> `master` PR, a protected `master`, and successful Development
deployment of that head. Prefer merge commits. The workflow token stays read-only.

**Production starts disabled:** leave repository variable
`PRODUCTION_DEPLOYMENT_ENABLED` unset. Only after owner approval, configure the
protections/secrets and set it to `true`. This PR does not activate it, change live
settings, merge a release or apply hosted SQL.

`vercel.json` disables all automatic Git deployments, including feature branches.
Retain the linked Git repository, existing ignored-build filter (`master|develop`
only), Next.js preset, Node 24, pinned pnpm/Corepack, Frankfurt region, automatic
custom-domain assignment and `all_except_custom_domains` Authentication. Releases
explicitly set the non-secret build flag `ENABLE_EXPERIMENTAL_COREPACK=1`
so Vercel installs the exact `packageManager` version, including pnpm 12's lockfile.
Development is bound to `develop`. After a verified READY Preview and another
branch-head check, Actions explicitly runs `vercel alias set` for
`duty-scheduler-dev.vercel.app` in the existing team. Metadata alone is not the
promotion mechanism. Production retains automatic assignment through the
Production deployment; its domain has no branch binding. Both releases require
the domain's Alias API record to match the verified deployment ID and project,
without a redirect, before reporting success. Do not create protection bypasses.
Set Preview and Vercel Development app variables to Development, Production app
variables to Production. Actions explicitly supplies the matching runtime URL/key;
no database password is sent to Vercel.

Before activation, verify there are no competing Vercel deployment hooks/workflows
or Supabase GitHub integration migration deployments. Disable automatic Supabase
branching/migration sync if configured: Actions must be the sole migration writer.
Configure Development secrets before merging this PR so its first merge deployment
can succeed. Promoting this configuration to `master` deliberately disables Git
auto-deployment while Production activation remains gated.

## Database feature workflow

1. Branch from `develop`; change canonical SQL/reference definitions. Update
   `baseline.json`/`config.toml` when adding sources.
2. Use pinned CLI `supabase migration new <name>` or the documented declarative
   diff workflow. Review new incremental SQL, ordered after existing versions.
   Never change applied files/frozen hashes or include operational test fixtures.
3. Include relevant `supabase/tests` regressions for grants/RLS, checked RPC
   compatibility, changed behavior and preservation. Update clean-install/catalog
   assertions deliberately when introducing objects/reference rows.
4. Open a PR to `develop`. Quality enforces immutable history against its exact
   base and canonical SQL + new migration + SQL regressions together. It validates
   fresh canonical replay, existing security/RPC/race tests, upgrades with synthetic
   identities/private notes/publications/duties, retained RPC signatures/named
   arguments/result types, and unchanged build/browser/visual
   checks. All SQL testing stays local.

Use **expand/migrate/contract**: add nullable columns/tables/functions while retaining
old RPC signatures; backfill in bounded, reviewed migrations; switch callers in a
later release. Contract obsolete objects only after old app/browser callers retire.
Review compatibility and add old-caller regressions: CI cannot prove every semantic
property. Required static rows belong in migrations, not local seeds.

## Development and Production

A merge/push to `develop` first runs Quality. Its database contract artifact is
bound to the same Actions run and exact SHA; privileged jobs never consume PR
artifacts. Development credentials are released only to its deployment job. It
checks the latest branch SHA, project-qualified database URL, Vercel protection/
domain bindings and existing history, then:

1. Dry-run and push only pending migrations; skip both when none exist. Never
   include seeds, roles, resets, history repair or `--include-all`.
   The CLI receives a password-free connection URL; `PGPASSWORD`/
   `SUPABASE_DB_PASSWORD` are scoped to its process environment. Passwords and
   tokens never appear in process arguments. The publishable runtime key travels
   through a temporary owner-readable Vercel config outside source uploads and is
   removed on success/failure; Vercel authentication uses `VERCEL_TOKEN` in its env.
2. Require complete matching history. Compare read-only application catalog
   fingerprints (schema, effective grants/RLS and RPC definitions) and static
   lookup rows with Quality's verified local DB. No private operational rows or
   live revision are read/compared. Any mismatch blocks the app.
3. Deploy the same checkout via pinned Vercel CLI, with matching target, branch/SHA
   metadata and runtime URL/key. Wait for READY and verify project/SHA/branch/target.
4. Recheck the Development branch head, explicitly assign its stable domain with
   `vercel alias set`, then read back the Alias API record. Its deployment ID must
   equal that verified READY deployment; an old binding fails even if the build's
   alias list contains the domain. Keep Vercel Authentication and branch binding.

A non-cancelling lock covers both migration and deployment per environment.
New pushes cancel obsolete tests, never an active migration. Queued stale SHAs
fail before writes; the branch is checked again immediately before app deployment
and before Development alias assignment after the build.
No hosted identities/notes/schedules are reset or used as test fixtures.

For Production, open a **maintainer-reviewed `develop` -> `master` release PR** after verifying
Development. Merge only with owner authorization. `master` Quality must pass;
with activation enabled, Actions checks the merged PR, protected branch and
Development deployment, then waits for **explicit Production Environment approval**.
Only after approval can it use Production credentials, migrate/verify Production
and deploy the corresponding `master` app. Its custom domain updates automatically;
Actions verifies that its Alias API record points to that exact deployment. It
never manually aliases a Preview or Development artifact onto Production.
Feature PRs cannot enter hosted jobs. The workflow never merges or approves PRs.

To retry, run **Quality** with **Run workflow** on the current `develop`/`master`
branch, or rerun its failed deploy job. All gates apply again; Quality recreates the
SHA contract. Stale releases/expired artifacts need a current Quality run.

## Failure and recovery

- Quality/approval/credential failure: no migration/app deployment starts.
- Migration/contract failure: app deployment is blocked; the old app keeps serving.
  Earlier successful migration files may remain applied. CLI runs each normal file
  transactionally; isolated probes verify partial DDL and failed history roll back.
- Vercel build failure: old deployment keeps serving; applied SQL remains. Fix
  forward or retry the current SHA after correcting configuration. A domain check
  failure after READY may mean the new app is already assigned; inspect Vercel.
- Development alias assignment/read-back failure: the job fails without reporting
  release success. Inspect the domain's actual deployment ID before retrying; do
  not remove aliases or reset SQL automatically. Applied migrations remain applied.
- Actions identifies the failed stage/status and job summary. Detailed SQL/CLI
  errors are suppressed because they can contain private rows/credentials; inspect
  service diagnostics privately, never paste credentials into CI logs.

Restrict releases during investigation. Read history/catalogs in the explicitly
selected environment and identify committed files. Create a **new reviewed forward
fix** with matching canonical SQL/regressions, verify locally and on Development,
then approve Production. Never edit applied SQL, blindly replay/repair history or
stamp failed SQL as applied. Correcting an **unapplied** failed file requires an
operator-reviewed exception to the default immutable-history check. Reconcile any
nontransactional effects under a separately approved recovery plan.

Vercel rollback chooses an older **same-environment** app compatible with the current
expanded schema; it does **not** reverse SQL. Never promote a Development artifact
to Production. For data loss, preserve evidence/data, stop writes and obtain owner
approval before restoration. Free projects need a separately secured off-site
operator-managed backup before destructive changes; do not assume paid PITR exists
or put private backups in GitHub artifacts. Restore into an isolated project first,
validate identities/permissions/history and reconcile later writes before cutover.

## Supplied verification

`tests/release.test.mjs` covers credential isolation, migration policy/history,
contract failures, approval gates, ordering, explicit Development alias assignment
and rejection of stale/cross-project/redirected domain bindings. Production tests
require automatic assignment without a manual alias command. `scripts/release-local-test.mjs`
uses the **actual CLI** in a temporary local work directory: no-op release, safe
additive private test table, then an intentionally failing migration. A synthetic
application hook runs only after DB verification; failure must block it and roll
back the failing file. Probes never enter committed history; the disposable DB is
reset afterward. This is isolated end-to-end verification, not a claimed live
Vercel rollout. Live domain/OAuth acceptance needs an authorized post-merge
Development release with configured Environment secrets.

References: [Supabase CI/CD](https://supabase.com/docs/guides/deployment/managing-environments),
[Vercel Git deployment controls](https://vercel.com/docs/project-configuration/git-configuration),
[CLI branch metadata](https://vercel.com/docs/cli/deploy#associate-a-cli-deployment-with-a-git-branch),
[explicit CLI alias assignment](https://vercel.com/docs/cli/alias),
[Alias API read-back](https://vercel.com/docs/rest-api/aliases/get-an-alias),
[database architecture](../supabase/README.md), [auth/onboarding](SUPABASE_SETUP.md).
