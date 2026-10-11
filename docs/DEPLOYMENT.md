# Clean European environments

## Release checkpoint — 12 October 2026

The current task authorizes the European cutover, merge commit for PR #1, later
reversible Tokyo pause, $0 Frankfurt Development creation and deployments once
readiness passes. Never permanently delete Tokyo or touch CPR.

Verified this session:
- Frankfurt `hpszwgnwxtxyxpcaivgj` is healthy in `eu-central-1`. Clean-install SQL
  passes; all Auth and operational counts are zero; both canonical migrations and
  frozen hashes are correct; security advisor has no findings. No reset was needed.
- Catalog/permission fingerprints: tables `9a5f3a8157bd67b1d10aaca4b6e0d8b9`,
  functions `c6b9e02563b497c1d2e3178682a3c74d`, constraints
  `4f41119bbceb6b79d086ac6ba0746827`, indexes `ddedc3b94040e1aab5353d5c83fca3ca`,
  policies `6ddfd6214c8daa60b407013d215a0038`, private schema
  `e92c95c156c76736c4f622c5dc2bf257`, trigger `c759a41c3984688b290753e15b008849`.
- PR #11 merged at `dea7681bddb46ab15ae4e4bfffb134e452b76c37`; PR #1 includes it,
  is mergeable and both current-head Quality checks passed (SQL/build/browser).
- Public Production is `https://duty-scheduler-two.vercel.app`; `/api/config`
  confirms Tokyo. Served deployment: `dpl_9XesSiM6cnD3odbQ7E3pWtyfEDRu`.
- Protected Frankfurt verification Preview below returns HTTP 200 and Frankfurt
  configuration. Its application code matches `develop`; Google is disabled.
- Future Vercel function deployments now use `fra1`; Next.js, Node 24 and `master`
  Production branch retained. Temporary automation bypass revoked: zero remain;
  normal `all_except_custom_domains` Vercel Authentication remains enabled.
- Organization `vaplnkaubzopjbixlxng` is Free; project creation quote is $0/month.

Human blocker: no authenticated Google Cloud tool; Supabase MCP lacks Auth-provider
and rename operations, and Supabase CLI has no management login. Configure Google
in the dashboards; secrets belong only in Supabase. Rename Frankfurt to exactly
**Duty Scheduler** without changing its ref. If CLI management login is needed,
run `pnpm dlx supabase@2.119.0 login` locally; never send tokens in chat.
Vercel MCP returns scope 403; authenticated CLI/API works with team
`team_pbvqzViC50aeT2kaRNnTYkPt`, scope `omri1701s-projects`.

Resume: verify Production Google and owner sign-in at the protected verification
Preview; verify the actual Google UUID and pending member, then explicitly promote.
Recheck final PR #1 Quality; configure Frankfurt Production variables and remove
obsolete project-specific integration extras; merge #1 with a merge commit, deploy
its actual `master` SHA and verify the public domain. Only then pause Tokyo
Production and create **Duty Scheduler Dev** in Frankfurt. Install the two canonical
migrations through an isolated CLI directory with explicit ref/dry run/push; compare
all fingerprints above and reference rows with the Production pre-onboarding gate.
Configure separate Development Google, Preview and Vercel Development variables.
Stable branch URL: `https://duty-scheduler-git-develop-omri1701s-projects.vercel.app`.
Verify its exact Development ref; write Git-ignored `.env.local` with Development
only, verify port 5173/sign-in/reload/refresh and update user-local `supabase_dev` MCP
to the new ref. Promote only the owner's separately confirmed Development account.
After successful master deployment, make GitHub default `master`, retain feature
PRs to `develop`, and require Actions `quality` on both branches, prohibiting force
push/deletion without mandatory second-person review for the solo maintainer.

Development is not created; `.env.local` is absent. Never pull Vercel Production
variables into it. Tokyo Production remains active; Tokyo Development is paused.
No Tokyo data was imported. Retire temporary Production verification origin and
deployment after cutover; keep shared Development Previews isolated and protected.

The strategy is fresh initialization, not regional data transfer. Never export,
copy or restore Tokyo accounts, credentials, private notes or operational records.

## Current verified state

| Environment | Branch / hosting | Supabase | Status |
|---|---|---|---|
| Original / rollback | Current served Vercel Production | Tokyo `ukxxpbivgxyxharhxgqf` | Active, original data and eight migration records preserved; no writes by this task |
| New Production target | `master` / Vercel Production after readiness | Frankfurt `hpszwgnwxtxyxpcaivgj` | Clean, canonical baseline initialized and verified; Google disabled; not cut over |
| New Development target | `develop` / Vercel Preview | Separate Frankfurt ref, not created | Blocked by two-active-project Free quota |
| Old Development | None | Tokyo `civayswojfpujiszlbnu` | Paused, unchanged |

The existing Free organization is `vaplnkaubzopjbixlxng` (`omri1701`). Tokyo
Production and Frankfurt already occupy its two active slots. Paused projects do
not occupy a slot. Two working European projects cannot coexist with active Tokyo
on this Free quota. No paid branching, additional billable resources or unrelated
project changes are authorized. The current task authorizes pausing Tokyo Production
after successful European cutover. Never pause it before Vercel stops using it;
never delete either original without separate final confirmation.

## Canonical installation

See [database architecture](../supabase/README.md). Fresh projects install only:

1. `20261011212413_clean_baseline.sql`
2. `20261011212421_required_reference_data.sql`

Required rows: two roles, three membership statuses, two month statuses, two
constraint types, and the revision singleton at zero. No users, identities,
members, assignments, availability/constraints, months, publications or swaps.
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

Configure an independent Production Google web client with the Frankfurt callback
`https://hpszwgnwxtxyxpcaivgj.supabase.co/auth/v1/callback`.
Enable Google in Frankfurt Authentication providers; enter its client ID and secret
there only. The isolated verification Preview is
`https://duty-scheduler-rmqhsz2gy-omri1701s-projects.vercel.app` (deployment
`dpl_Yjz6wQ7YKsJNrvf1Jp6NcTfqmZBy`, Ready). Production Site URL is
`https://duty-scheduler-two.vercel.app`. Add that origin and the temporary verification
origin to the Production Google client; allow both exact trailing-slash returns in
Supabase. Retire the verification origin after cutover. Keep Tokyo OAuth unchanged.
The app uses existing PKCE and `window.location.origin + '/'`; no UI/auth code changed.

After the owner signs in successfully, normal `duty_join` creates a pending,
inactive engineer profile. Confirm the target project and actual `auth.users.id`
with the owner, then execute [the operator-only bootstrap](../supabase/admin/promote-first-admin.sql)
through authenticated database administration. With MCP, replace only the UUID
parameter with the confirmed value and retain the transaction and all checks.
The script requires a trusted operator role, a verified Google identity and matching
pending profile; it refuses any existing admin and updates revision under the
workspace lock. It is never deployed as an RPC, email allowlist or first-user rule.
Existing checked approval/role RPCs support multiple admins and protect the last admin.

Development needs its own Google web client, audience/test accounts and callback
for its eventual distinct ref. Use only `openid`, `userinfo.email`, `userinfo.profile`.
Configure its exact develop Preview origin and `http://localhost:5173/` independently.
Store Google secrets only in the appropriate Supabase project. Verify real PKCE,
return origin, reload, refresh, sign-out and pending approval separately in each
environment. Keep application users/data separate.

## Hosting and approval gate

Vercel project `prj_Jl2PBhK8DsvK183rKKWesr0821OY`, scope `omri1701s-projects`,
uses Next.js, Node 24 and Production branch `master`. Production is still the
original served deployment using Tokyo. Preview has no application database
variables and fails closed until independent Development exists.

Preserve the native runtime, `pnpm build`, default output and Corepack setting.
The only database variables the app needs are `SUPABASE_URL` and
`SUPABASE_PUBLISHABLE_KEY`. Production must use Frankfurt Production; Preview
and Vercel Development must use the independent Frankfurt Development project.
No `NEXT_PUBLIC_`, service-role, database password or Google secret is used by the
application. Audit existing integration-managed extras without changing Production
before readiness. Keep Preview sync/branching off and prevent branch overrides from
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
with Frankfurt variables. PR #11 is merged; PR #1 remains open pending readiness.

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
