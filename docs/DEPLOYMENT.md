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

Production must have **required reviewers** for explicit deployment approval;
disable admin bypass and prevent self-review when a second operator is available.
The release gate checks reviewers are configured before requesting approval.
Protect both branches with `quality`, prohibit force pushes/deletion, and require
reviewed PRs/no direct pushes to `master`. Production verifies final-head PR approval
and a successful Development deployment of that head. Prefer merge commits for
`develop` -> `master`. The workflow token has only read permissions.

**Production starts disabled:** leave repository variable
`PRODUCTION_DEPLOYMENT_ENABLED` unset. Only after owner approval, configure the
protections/secrets and set it to `true`. This PR does not activate it, change live
settings, merge a release or apply hosted SQL.

`vercel.json` disables all automatic Git deployments, including feature branches.
Retain the linked Git repository, existing ignored-build filter (`master|develop`
only), Next.js preset, Node 24, pinned pnpm/Corepack, Frankfurt region, automatic
custom-domain assignment and `all_except_custom_domains` Authentication. CLI GitHub
branch/SHA metadata updates the existing domain; Development is bound to `develop`,
Production has no branch binding. Do not create protection bypasses.
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
   identities/private notes/publications/duties, and unchanged build/browser/visual
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
2. Require complete matching history. Compare read-only application catalog
   fingerprints (schema, effective grants/RLS and RPC definitions) and static
   lookup rows with Quality's verified local DB. No private operational rows or
   live revision are read/compared. Any mismatch blocks the app.
3. Deploy the same checkout via pinned Vercel CLI, with matching target, branch/SHA
   metadata and runtime URL/key. Wait for READY and verify project/SHA/target/domain.

A non-cancelling lock covers both migration and deployment per environment.
New pushes cancel obsolete tests, never an active migration. Queued stale SHAs
fail before writes; the branch is checked again immediately before app deployment.
No hosted identities/notes/schedules are reset or used as test fixtures.

For Production, open a **reviewed `develop` -> `master` release PR** after verifying
Development. Merge only with owner authorization. `master` Quality must pass;
with activation enabled, Actions checks the merged PR, final-head review and
Development deployment, then waits for **Production Environment approval**.
Only after approval can it use Production credentials, migrate/verify Production
and deploy the corresponding `master` app. Its custom domain updates automatically.
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
contract failures, approval gates and ordering. `scripts/release-local-test.mjs`
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
[database architecture](../supabase/README.md), [auth/onboarding](SUPABASE_SETUP.md).
