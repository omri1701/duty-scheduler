# Clean European environments

## Release checkpoint — 12 October 2026

The authorized Production cutover is complete. Never permanently delete Tokyo or
touch CPR. No Tokyo users, credentials or operational data were copied.

Verified:
- Frankfurt Production `hpszwgnwxtxyxpcaivgj` is healthy in `eu-central-1` and named
  **Duty Scheduler**. The owner's real Google login created its sole identity and
  pending profile; owner confirmation preceded the unchanged operator-only bootstrap.
  It now has one approved active admin. Authenticated `duty_load` verifies admin
  visibility; operational tables remain empty. Public-origin interactive admin UI
  verification remains a user check; the pre-cutover Google login was on the Preview.
- PR #13 passed Quality and merged into `develop` at
  `faace06548e91b3bb35fb2ba9c8a2d5a7d8b9013`. PR #1 passed both final-head Quality
  checks and merged with a merge commit: `1aca4146eb9d268c2dbb75dd8b8cca23e951d0d3`.
  Master Quality also passed; existing SQL/build/browser checks were reused.
- Public Production: https://duty-scheduler-two.vercel.app, deployment
  `dpl_ER4wN86yiAkxB6mQHMFDZZehfiRr`, built from that master SHA. Page and
  `/api/config` return 200; configuration matches Frankfurt Production's
  publishable key and uses `no-store`. Google initiation returns 302 with its
  Frankfurt callback. The application no longer connects to Tokyo.
- Tokyo Production `ukxxpbivgxyxharhxgqf` was paused only after these gates passed.
  Tokyo Development `civayswojfpujiszlbnu` remains paused and unchanged. Both
  projects and their data are retained; nothing was permanently deleted.
- Separate Frankfurt Development `qhndiuahuxczujxxitsm` is healthy and named
  **Duty Scheduler Dev**, created at $0/month in Free organization
  `vaplnkaubzopjbixlxng`. Only the two canonical migrations were pushed from an
  isolated CLI directory after a dry run. All seven schema/permission fingerprints
  match Production's pre-onboarding baseline below; security advisor has no findings.
  Auth identities, users and operational tables are zero; required rows are 2 roles,
  3 member statuses, 2 month statuses, 2 constraint types and revision zero.
- Vercel Production's two application credentials point only to Production.
  Preview and Vercel Development variables point only to Frankfurt Development;
  no branch-specific database overrides exist. Native Next.js, Node 24, Corepack,
  `master` Production branch and `fra1` functions are preserved.
- Development deployment `dpl_Ho7cwySgjNjYyVzuFeHzktVSz1h1` is Ready at
  https://duty-scheduler-f2mkgme44-omri1701s-projects.vercel.app. Its Chrome
  page/config checks pass against Development. Stable branch alias:
  https://duty-scheduler-git-develop-omri1701s-projects.vercel.app.
  The verified obsolete develop-host condition was removed from the historical
  Tokyo-isolation firewall rule. Chrome page/config checks now return 200 at the
  stable alias. All other 14 historical blocks and Vercel Authentication remain.
- Git-ignored `.env.local` points only to Development; localhost:5173 page/config
  checks return 200. The user-local `supabase_dev` MCP URL now uses the new ref.
  Restart the MCP client/session when needed to load that connection change.
- Production Auth allows only https://duty-scheduler-two.vercel.app/.
  Development Site URL is the stable develop alias; its exact return and
  http://localhost:5173/ are allowed. Development Google uses a separate Web client
  with exactly these origins and its Frankfurt Development callback. Real Preview
  Google login created the sole verified identity and pending member. After direct
  owner confirmation, the unchanged operator-only script promoted that exact account
  to the sole approved active admin. A read-only `duty_load` check under that account's
  authenticated database role verifies admin workspace visibility; it does not prove
  browser session persistence. Production Auth settings were not modified.
- The temporary Production verification Preview `dpl_Yjz6wQ7YKsJNrvf1Jp6NcTfqmZBy`
  and redirect were retired. Every short-lived verification share link was revoked.
- GitHub default branch is `master`. Feature PRs continue to target `develop`;
  release PRs are `develop` → `master`.
  Both branches now require a PR and the GitHub Actions `quality` check on an
  up-to-date branch, enforce these requirements for admins, and block force pushes
  and deletion. Reviewer count is zero so the sole owner can merge a passing PR;
  agent merges still require explicit owner approval. Fourteen unused integration
  variables remain confined to Production and were retained under the instruction
  to leave Production untouched. Application variables and Corepack are unchanged.

Remaining gate: owner verification of the localhost Google login, persisted sessions
and admin workspace on both origins, then final checkpoint PR Quality CI. The Google
JSON remains in ignored `work/dev-google-client.json`, excluded from deployment
uploads. No users or operational records were copied between environments.

## Current verified state

| Environment | Branch / hosting | Supabase | Status |
|---|---|---|---|
| Production | `master` / public Vercel | Frankfurt `hpszwgnwxtxyxpcaivgj` | Live, one owner admin, Google enabled |
| Development | `develop` / Preview and localhost | Frankfurt `qhndiuahuxczujxxitsm` | Separate Google client; sole approved owner admin; browser session checks pending |
| Original Production / rollback | Retained old Vercel deployment | Tokyo `ukxxpbivgxyxharhxgqf` | Paused; original data/history retained |
| Old Development | None | Tokyo `civayswojfpujiszlbnu` | Paused, unchanged |

The Free organization now has two active Frankfurt projects. No paid branching,
billable add-ons or unrelated project changes are authorized. Never delete either
Tokyo original without separate final confirmation. The old Production deployment
`dpl_9XesSiM6cnD3odbQ7E3pWtyfEDRu` is retained; Tokyo must be restored before using
it for rollback, and new European records must be preserved.

## Canonical installation

See [database architecture](../supabase/README.md). Fresh projects install only:

1. `20261011212413_clean_baseline.sql`
2. `20261011212421_required_reference_data.sql`

Required rows: two roles, three membership statuses, two month statuses, two
constraint types, and the revision singleton at zero. No users, identities,
members, assignments, availability/constraints, months, publications or swaps.
Both Frankfurt installations match these frozen catalog fingerprints:

| Category | Objects | Fingerprint |
|---|---|---|
| Tables | 11 | `9a5f3a8157bd67b1d10aaca4b6e0d8b9` |
| Functions | 30 | `c6b9e02563b497c1d2e3178682a3c74d` |
| Constraints | 52 | `4f41119bbceb6b79d086ac6ba0746827` |
| Indexes | 35 | `ddedc3b94040e1aab5353d5c83fca3ca` |
| Policies | 11 | `6ddfd6214c8daa60b407013d215a0038` |
| Private schema | 1 | `e92c95c156c76736c4f622c5dc2bf257` |
| Trigger | 1 | `c759a41c3984688b290753e15b008849` |

Optional synthetic data is confined to tests, never remote installation seeds.
Eight historical migrations remain outside active migration discovery for Tokyo
traceability and upgrade tests. Do not replay, reset, repair or alter Tokyo history.

Frankfurt was explicitly verified as the disposable `eu-central-1` project.
Preflight found three copied users/identities, five sessions, no Storage objects
or buckets, no custom Auth triggers, no private tables and no external application
FK dependencies. Only the known Duty tables/functions/private schema and its
obsolete copied migration records were cleared. Users were deleted using the
[documented direct Auth user deletion](https://supabase.com/docs/guides/auth/managing-user-data#deleting-users),
with managed cascades removing identities and sessions; no Supabase-managed schema
or Auth infrastructure was reset, truncated, recreated or modified. Temporary
cleanup history was removed from this disposable target before installing the two
canonical migrations. This is a completed, target-specific operation, not a
reusable reset procedure for existing environments.

Hosted clean-install checks passed. All application schema and effective client
permission fingerprints match the disposable local installation: 11 tables,
52 constraints (21 FKs), 35 indexes, 30 functions, 11 policies and one trigger.
Auth/application counts are zero except required rows. Anonymous RPC access is
rejected; the security advisor has no findings. Informational unused-index notices
are expected on an empty database; retain FK/lookup indexes for real usage.
Local historical replay matched all 169 dumped schema objects and ACLs. Fresh reset
was repeated, and access, publication/availability, swap consent, upgrade,
concurrency and actual operator-bootstrap tests passed. These checks do not prove
real Google OAuth; no hosted synthetic fixtures were run on the Production target.

## Google sign-in and first admin

Production Google is enabled with callback
https://hpszwgnwxtxyxpcaivgj.supabase.co/auth/v1/callback. Its Site URL is
https://duty-scheduler-two.vercel.app and its only allowed return is that origin
with a trailing slash. Owner sign-in, identity confirmation and explicit promotion
are complete. The old verification Preview and return are retired.
The app preserves PKCE and the origin plus trailing-slash return; no auth UI changed.

After the owner signs in successfully, normal `duty_join` creates a pending,
inactive engineer profile. Confirm the target project and actual `auth.users.id`
with the owner, then execute [the operator-only bootstrap](../supabase/admin/promote-first-admin.sql)
through authenticated database administration. With MCP, replace only the UUID
parameter with the confirmed value and retain the transaction and all checks.
The script requires a trusted operator role, a verified Google identity and matching
pending profile; it refuses any existing admin and updates revision under the
workspace lock. It is never deployed as an RPC, email allowlist or first-user rule.
Existing checked approval/role RPCs support multiple admins and protect the last admin.

Development has its own Google web client, audience/test accounts and callback
at https://qhndiuahuxczujxxitsm.supabase.co/auth/v1/callback. Use only `openid`, `userinfo.email`, `userinfo.profile`.
Configure its exact develop Preview origin and `http://localhost:5173/` independently.
Store Google secrets only in the appropriate Supabase project. Verify real PKCE,
return origin, reload, refresh, sign-out and pending approval separately in each
environment. Keep application users/data separate.

## Hosting and approval gate

Vercel project `prj_Jl2PBhK8DsvK183rKKWesr0821OY`, scope `omri1701s-projects`,
uses Next.js, Node 24 and Production branch `master`. Production serves Frankfurt.
Preview and Vercel Development use the separate Frankfurt Development database.
The stable develop alias has passed Chrome page/config checks after the one-hostname
firewall cleanup; all historical Tokyo-connected Preview protections remain.

Preserve the native runtime, `pnpm build`, default output and Corepack setting.
The only database variables the app needs are `SUPABASE_URL` and
`SUPABASE_PUBLISHABLE_KEY`. Production must use Frankfurt Production; Preview
and Vercel Development must use the independent Frankfurt Development project.
No `NEXT_PUBLIC_`, service-role, database password or Google secret is used by the
application. Remove the 14 unused integration variables only with the specifically
requested approval. Keep Preview sync/branching off and prevent branch overrides from
pointing ordinary development builds at Production.

A temporary isolated verification Preview may use explicit Frankfurt overrides
without changing project-wide Production or Preview variables. It is for owner
onboarding/auth readiness only, not the eventual shared Development environment.
The explicit `.vercelignore` keeps local credentials, transfer work, AI settings
and generated diagnostics out of CLI deployment uploads.

Before actual cutover: verify the final schema/permissions/API contracts, real
Google login at the exact verification origin, clean onboarding, correct project
URLs/keys. Development creation follows cutover and the authorized Tokyo pause;
it cannot be a pre-cutover gate on the two-project Free quota. Record the currently served
deployment and domains. Request explicit approval for Production variables,
domain/deployment changes and the release merge only if not already authorized by
the current task. Do not promote a Development
Preview artifact into Production. Build Production from the approved `master` SHA
with Frankfurt variables. PRs #11, #12, #13 and release #1 are merged.

Do not claim two environments are working until Development is created, initialized,
validated, independently configured and auth-tested. An approved Tokyo pause, if
performed after the authorized cutover, preserves its data but changes availability.
Never delete Tokyo. Rollback hosting does not
roll back new European data; preserve any new records before a rollback decision.

## Repository and release checks

The temporary transfer runners, connection/password diagnostics, backup experiments,
credential file and generated migration artifacts are retired. `.env*`, `work/`,
`outputs/` and CLI caches stay Git-ignored; deployment uploads also exclude them.
No transfer tool or operational database export belongs in the final architecture.

Run the generated-baseline check and the documented SQL/bootstrap/concurrency tests
on empty disposable local Supabase. Run unit tests, TypeScript, lint, AI configuration,
production build and browser/visual comparison; retain existing snapshots. Quality CI
checks the final feature PR to `develop`. This task authorizes repository delivery;
the Production release still requires all readiness gates to pass.
