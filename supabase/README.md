# Supabase database architecture

`schemas/` and `reference-data/` are the authoritative application definitions.
The two baseline migrations are generated deployment artifacts, never manual copies.
Supabase owns `auth`, `storage`, platform roles and extensions; this repository does
not recreate them. The application exposes only checked RPCs and RLS-filtered reads.

```text
supabase/
  schemas/
    tables/                 # Tables, constraints, FKs, indexes and RLS
    functions/duty_private/ # Checked implementations and internal helpers
    functions/public/       # API-compatible, invoker RPC wrappers
    constraints/            # Deferred month/publication cyclic FK
    triggers/               # Publication swaps/accounting, participation, audit immutability
    policies/               # One select policy per table
    grants/                 # Explicit table and function privileges
    shared.sql              # Application-private schema only
  reference-data/           # 4 lookup tables + required workspace singleton
  migrations/               # 2 frozen baselines plus incremental migrations
  archive/migrations/       # 8 immutable historical files, outside CLI discovery
  admin/                    # Operator-only first-admin procedure; never an RPC
  tests/                    # Clean schema, permission, publication, swap and bootstrap checks
  baseline.json             # Explicit dependency order and complete source inventory
  config.toml               # Local CLI configuration; seeding disabled
```

No development fixtures are installed by migrations. All synthetic fixtures live
in tests and are rolled back or cleaned up. Required lookup rows and the revision
singleton are installed by a migration on local AND remote databases.

## Generate and verify the initial baseline

```sh
node scripts/database-baseline.mjs
node scripts/database-baseline.mjs --check
node scripts/database-baseline.mjs --verify-local supabase_db_duty-scheduler
```

Generation concatenates normalized UTF-8/LF sources in `baseline.json` order and
checks that every SQL source appears exactly once. It also generates CLI
`schema_paths` from that same manifest. Quality CI checks the generated artifacts.
Tables precede functions; the month/publication cyclic FK is added after both
exist. Function body checking is deferred until all helpers exist; SQL regressions
exercise their real runtime dependencies. The baseline contains 52 constraints
(21 foreign keys), 35 indexes including constraint indexes, 30 functions, 11 RLS
policies and one custom trigger. No obsolete specials, split-weekend or manager
reservation tables remain.

## Fresh installation

For a disposable local Supabase instance, use `supabase start` then
`supabase db reset --local --no-seed`. For a new hosted project, use an isolated
CLI work directory, copy these two migrations, link explicitly to the verified
new ref, inspect `supabase db push --dry-run`, then `supabase db push`.
Never reset a cached hosted link. Check the ref, region, environment and empty
Auth/application state before any write. Google provider settings are configured
separately; passwords, keys and OAuth secrets are not migration data.

`tests/schema.sql` asserts zero users/identities and operational rows, exact required
rows, 13 RLS-protected tables, 23 valid FKs, 83 functions, restricted grants and
safe search paths. `tests/fingerprint.sql` compares all application columns,
constraints, indexes, triggers, policies, function definitions and effective client
permissions with the local installation. Neither reads private operational data.
See [Supabase setup](../docs/SUPABASE_SETUP.md) for commands and fixture limits.

## Existing projects and future changes

Tokyo `ukxxpbivgxyxharhxgqf` retains its existing eight migration records unchanged.
Do NOT push this replacement history there or repair its history to resemble a
fresh installation. The archive preserves byte-identical historical SQL and the
v1/v2 swap upgrade regression; it is not another authoritative current schema.

The baseline versions are now applied to Frankfurt and immutable. Their normalized
SHA-256 hashes are frozen in `baseline.json`; generation refuses to overwrite an
applied baseline with changed sources. Quality checks both those hashes and real
catalog equivalence between migration replay and canonical sources on a disposable
local Supabase Postgres instance. This continues to work with incremental migrations.
The canonical install bundle remains deterministic:

```sh
node scripts/database-baseline.mjs --bundle > work/current-install.sql
```

Future changes edit canonical sources first, then create an incremental migration
with the current Supabase CLI declarative workflow, or install that bundle in an
empty LOCAL application schema and use `supabase db diff -f <name> --schema public,duty_private`
against the existing migration history. Inspect installed CLI `--help`; `db diff`
compares migrations with a live/local catalog, not merely text files. Review generated
SQL, update the source manifest/derived schema paths when adding files, and run
`--verify-local` against the resulting migration replay. Never push a canonical
CREATE bundle onto an existing database or modify a frozen baseline/hash to pass.
The lightweight `--check` additionally enforces byte equality while the baseline is
the only migration pair; with later incremental migrations the real catalog gate
checks the final state. Reference changes need separate explicit migrations and
comparison with canonical required rows; local seeds do not deploy required DML.
Test both a fresh reset and the upgrade from the prior version, then validate
Development before separately approving Production application.

PR #28 changes only existing tables/functions: NULL-publication assignment rows
exist for open drafts; Published months use their current immutable publication
without working duplicates. The revised conversion is intentionally fail-closed
on ambiguous Published working data. See the [revised migration plan](../docs/SUPABASE_SETUP.md#pr-28-revised-migration-plan--hosted-approval-required)
for exact migrations, preservation rules and approval requirements. The prior
hosted Cancel Draft plan is superseded; no hosted migration is currently authorized.

Quality now enforces paired canonical definitions, new incremental migrations and
SQL regressions against the exact PR base. It tests real local upgrades with existing
synthetic identities/private notes/publications and a safe isolated deployment probe.
After merge, GitHub Actions is the sole hosted migration writer and verifies database
contracts before Vercel. See [release workflow](../docs/DEPLOYMENT.md) for Environment
secrets, reviewed Production releases, approval and forward-fix recovery.
