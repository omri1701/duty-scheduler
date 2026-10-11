# Clean European environments

The strategy is fresh initialization, not regional data transfer. Never export,
copy or restore Tokyo accounts, credentials, private notes or operational records.

## Current verified state

| Environment | Branch / hosting | Supabase | Status |
|---|---|---|---|
| Original / rollback | Current served Vercel Production | Tokyo `ukxxpbivgxyxharhxgqf` | Active, original data and eight migration records preserved; no writes by this task |
| New Production target | `master` / Vercel Production after approval | Frankfurt `hpszwgnwxtxyxpcaivgj` | Clean, canonical baseline initialized and verified; Google disabled; not cut over |
| New Development target | `develop` / Vercel Preview | Separate Frankfurt ref, not created | Blocked by two-active-project Free quota |
| Old Development | None | Tokyo `civayswojfpujiszlbnu` | Paused, unchanged |

The existing Free organization is `vaplnkaubzopjbixlxng` (`omri1701`). Tokyo
Production and Frankfurt already occupy its two active slots. Paused projects do
not occupy a slot. Two working European projects cannot coexist with active Tokyo
on this Free quota. No paid branching, additional billable resources or unrelated
project changes are authorized. The present instruction to leave Tokyo completely
unchanged also prohibits pausing it. Resolve that constraint explicitly before
creating Development; never silently pause or delete the original.

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

Configure the existing Production Google client with the Frankfurt callback
`https://hpszwgnwxtxyxpcaivgj.supabase.co/auth/v1/callback`, retaining Tokyo's callback.
Enable Google in Frankfurt Authentication providers; enter its client ID and secret
there only. The isolated verification Preview is
`https://duty-scheduler-rmqhsz2gy-omri1701s-projects.vercel.app` (deployment
`dpl_Yjz6wQ7YKsJNrvf1Jp6NcTfqmZBy`, Ready). Set that exact Site URL and
allow its trailing-slash return URL. Keep Tokyo OAuth settings completely unchanged.
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
before approval. Keep Preview sync/branching off and prevent branch overrides from
pointing ordinary development builds at Production.

A temporary isolated verification Preview may use explicit Frankfurt overrides
without changing project-wide Production or Preview variables. It is for owner
onboarding/auth readiness only, not the eventual shared Development environment.
The explicit `.vercelignore` keeps local credentials, transfer work, AI settings
and generated diagnostics out of CLI deployment uploads.

Before actual cutover: verify the final schema/permissions/API contracts, real
Google login at the exact verification origin, clean onboarding, correct project
URLs/keys and isolated Development/quota resolution. Record the currently served
deployment and domains. Request explicit approval for Production variables,
domain/deployment changes and the release merge. Do not promote a Development
Preview artifact into Production. Build Production from the approved `master` SHA
with Frankfurt variables. PR #1 and the feature PR remain unmerged pending approval.

Do not claim two environments are working until Development is created, initialized,
validated, independently configured and auth-tested. An approved Tokyo pause, if
later allowed, preserves its data but changes availability; it is a distinct action
requiring explicit authorization. Never delete Tokyo. Rollback hosting does not
roll back new European data; preserve any new records before a rollback decision.

## Repository and release checks

The temporary transfer runners, connection/password diagnostics, backup experiments,
credential file and generated migration artifacts are retired. `.env*`, `work/`,
`outputs/` and CLI caches stay Git-ignored; deployment uploads also exclude them.
No transfer tool or operational database export belongs in the final architecture.

Run the generated-baseline check and the documented SQL/bootstrap/concurrency tests
on empty disposable local Supabase. Run unit tests, TypeScript, lint, AI configuration,
production build and browser/visual comparison; retain existing snapshots. Quality CI
checks the final feature PR to `develop`. Do not merge without owner approval.
