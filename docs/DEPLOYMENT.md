# Deployment runbook

## Final infrastructure

| Environment | URL | Branch | Supabase |
|---|---|---|---|
| Production | https://duty-scheduler-prod.vercel.app | `master` | Frankfurt Production: `hpszwgnwxtxyxpcaivgj`, **Duty Scheduler**, `eu-central-1` |
| Development | https://duty-scheduler-dev.vercel.app | `develop` | Frankfurt Development: `qhndiuahuxczujxxitsm`, **Duty Scheduler Dev**, `eu-central-1` |
| Localhost | http://localhost:5173 | Local working branch | Frankfurt Development |

Google sign-in and administrator accounts work in both hosted environments.
Production and Development have separate Google OAuth clients, identities and
application data. Localhost uses Development credentials and its Google client.
No Tokyo users, credentials or operational data were copied into Frankfurt.

Vercel cleanup removed 18 obsolete Preview deployments; 5 deployments were
retained. Only `master` and `develop` build automatically.

Both Tokyo projects are **paused, not deleted**:

- Original Production: `ukxxpbivgxyxharhxgqf`.
- Original Development: `civayswojfpujiszlbnu`.

Their original data and history remain available for recovery after restoration.
The Free organization has two active Frankfurt projects. Do not delete either
Tokyo project or change unrelated projects.

## Hosting and environment scopes

Use the native Next.js preset, Node 24, `pnpm build`, default install/output
settings and `ENABLE_EXPERIMENTAL_COREPACK=1` for the pinned pnpm version.
Vercel functions use Frankfurt (`fra1`). `master` is the Production branch;
`develop` builds Preview for the stable Development URL above.

The application server variables are `SUPABASE_URL` and
`SUPABASE_PUBLISHABLE_KEY`. Production uses Frankfurt Production; Preview and
Vercel Development use Frankfurt Development. Keep `.env.local` on Development
and never pull Production variables into it. Keep Preview database sync/branching
off and prevent branch overrides from connecting Development to Production.
No `NEXT_PUBLIC_` prefix, service-role key, database password or Google secret
is needed by the application. Google secrets belong only in the matching
Supabase provider settings.

The project-level **Ignored Build Step** is:

```sh
case "$VERCEL_GIT_COMMIT_REF" in master|develop) exit 1 ;; *) exit 0 ;; esac
```

Exit 1 builds; exit 0 skips. Exact `master` and `develop` refs build, while feature
branches, similarly named branches and an empty ref skip. GitHub Quality still
runs on feature PRs targeting `develop` or `master`.

Keep Preview access protection. `.vercelignore` excludes local credentials,
transfer work, AI settings and generated diagnostics from CLI uploads.
`.env*`, `work/`, `outputs/` and CLI caches remain Git-ignored. Transfer tools,
credential files and operational database exports do not belong in the repository.

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

## Google sign-in and first admin

[Supabase setup](SUPABASE_SETUP.md) lists the exact Google origins, separate
callbacks, Supabase Site URLs and trailing-slash redirect URLs. Keep localhost
redirects confined to Development. The app uses PKCE and returns to the current
origin with a trailing slash.

For a fresh environment, a successful Google sign-in and `duty_join` create a
pending, inactive engineer profile. Confirm the target project and actual
`auth.users.id` with the owner, then execute
[the operator-only bootstrap](../supabase/admin/promote-first-admin.sql) through
trusted database administration. Replace only the confirmed UUID parameter;
retain the transaction and all checks. The script requires a verified Google
identity and matching pending profile, refuses an existing admin, and updates
the revision under the workspace lock. Existing environments already have
working administrator accounts; this is not a routine login step.

Checked approval/role RPCs support multiple admins and protect the last admin.
For later onboarding, verify the intended environment, Google return origin,
reload/session persistence, refresh, sign-out and pending-member approval.
Repository and SQL tests do not prove real Google OAuth.

## Release and rollback

GitHub's default branch is `master`. Feature PRs target `develop`; release PRs
are `develop` to `master`. Both branches require a PR and the GitHub Actions
`quality` check on an up-to-date branch, including for admins, and block force
pushes and deletion. Agent merges require explicit owner approval.

Before a release:

1. Verify Quality CI on the final PR head. Application changes require the
   documented generated-baseline, SQL/bootstrap/concurrency, unit, TypeScript,
   lint, production-build and browser/visual checks. Preserve existing snapshots.
   Documentation-only changes need instruction/link validation and final-head CI.
2. Confirm the target environment, application schema/permissions/API contracts,
   Google login and administrator workspace at the exact deployed origin. Run
   synthetic database tests only on empty disposable local projects, never against
   real members or Production.
3. Record the currently served deployment, commit and domain mappings for rollback.
   Obtain explicit authorization for the release merge and any live environment,
   domain, deployment or database changes.
4. Build Production from the approved `master` SHA with Frankfurt Production
   variables. Do not promote a Development Preview artifact into Production.
5. Verify the deployed page, `/api/config`, Google return origin, session reload
   and administrator workspace after release.

For a hosting rollback, select the recorded compatible deployment and verify its
variables and domain mapping before serving it. An old Tokyo-connected deployment
requires restoring Tokyo first, with explicit approval. Hosting rollback does not
roll back new Frankfurt data; preserve new records before any recovery decision.
Never replay, reset, repair or replace Tokyo migration history, and never delete
its retained projects as part of rollback.
