---
name: security-review
description: "Check Duty auth, RLS/RPC, permissions, private data, migrations or CI trust boundaries; skip cosmetic edits."
---

For auth/database work, read relevant docs/SUPABASE_SETUP.md sections and trace
server authorization. Check affected roles, ownership/private notes, escalation,
last-admin protection, publication immutability, revisions and deadlines.
Inspect RLS/grants and privileged functions together: caller identity,
authorization, safe search_path and execute permissions. Client roles/IDs or
user-editable metadata alone are insufficient authorization; snapshot simulations
do not verify database RLS.

Database changes require canonical `schemas/`/`reference-data/` SQL, updated source
manifests, a new CLI-created incremental migration and SQL/security/upgrade
regressions. Never rewrite applied migrations/hashes. Test fresh replay and
existing-data upgrades with compatible expand/migrate/contract changes.
`supabase/tests/access.sql` requires synthetic fixtures in an explicitly identified
empty development database, never real members. Report unavailable SQL validation.
Feature branches use Development `.env.local`; unmerged migrations stay local.
Only release branches migrate hosted databases; compatible feature previews are
manual. Application rollback never reverses SQL.

For CI/release changes, check token permissions, untrusted PR execution, action
pinning, secrets and write/deploy steps. Never run untrusted PR code with elevated
credentials via pull_request_target. Preserve release gates for the current branch
SHA, trusted full Quality attempt, artifact provenance/expiry and database source
identity, rechecked after approval/locks. Production requires manual dispatch,
activation and Environment approval. Review these controls locally; delivery does
not require observing Actions.

Report actionable findings with severity, file/line, prerequisites, impact and a
regression suggestion; distinguish confirmed issues from hypotheses.
