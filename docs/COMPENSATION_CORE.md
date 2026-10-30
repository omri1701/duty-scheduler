# Pure compensation core

`lib/compensation/index.ts` implements the accounting part of
[the authoritative specification](GENERATE_ALGORITHM.md), independently of UI,
allocation solving, storage and authorization. Database persistence uses the
same event contract and checked SQL replay; `lib/supabase/compensation.ts` uses
this core to read committed events. Application Generate projects this accounting
into the reviewed allocation and binds transfers to actual generated primary work.

## Contracts and use

Amounts are integer half-point `Units` (1 point = 2 units). `halfUnits` rejects
off-denomination/negative/unsafe input. All instants use UTC milliseconds. Duty
completion reuses the scheduling calendar's actual Jerusalem 09:00 handover.

```ts
import {record, reconcile, project, repaymentCandidates} from '../lib/compensation/index.ts';

const initial = record([], {
  sourceKey: 'opening-members', at: 1, actor: 'manager',
  operation: {kind: 'members', members: [{id: 'a', active: true}, {id: 'b', active: true}]},
});
const created = record(initial.events, {
  sourceKey: 'reviewed-opening-claim', at: 2, actor: 'manager', reason: 'Verified opening obligation',
  operation: {kind: 'claim', debtorId: 'a', creditorId: 'b', units: 3},
});
const actual = reconcile(created.events, 3);
const candidates = repaymentCandidates(actual.events);
const estimate = project(actual.events, 3, 4);
```

`record(history, command)` returns a new `LedgerView`, reconciling due published
contributions before the discretionary command. Registration/participation changes
belong in the same ordered history; never supply today's membership as its origin.
Source keys are unique business-operation keys. Identical retries are idempotent
(a later sampled time is allowed); changed content with the same key is rejected.
Keys starting with `@` are reserved for derived reconciliation events.

`replay(history)` validates committed sequence, event/source uniqueness, time order
and accounting effects. Input row order is irrelevant; effective corrections do
not reorder committed history. Views and returned events are isolated copies.
`ledgerFingerprint` is versioned and preserves business order and provenance paths.
It is canonical serialization, not a cryptographic hash or an authorization token.

## Provenance, corrections and reservations

Normalized segments retain exact source-lot slices and oldest contributing
priority. Opposing/cycle cancellation and chain bypasses are derived explanations,
not settlements. Gross lot `remaining` includes netted units; only normalized
claims are repayable. Settlement/reduction consumes the same amount on each path
leg, leaving intermediary net positions unchanged.

All discretionary accounting operations require a reason. A new `claim` can
increase an obligation with a newly dated segment. `adjust` reduces/settles a
selected current claim without crossing zero. `correct` references an original
lot and changes its reviewed face amount through a compensating lot at the current
sequence, preserving source priority. It does not insert history or erase earned
work. `reverse-settlement` explicitly reverses its net effect once; the completed
duty capacity stays consumed and cannot earn again.

A reservation binds source slices to a primary's date-atom capacity. Reservations
are exclusive across all months, including those after a projection cutoff.
`repaymentCandidates` returns unreserved active slices in original priority order.
The [allocation planner](ALLOCATION_PLANNER.md) chooses oldest-feasible amounts using global
weighted feasibility, creditor relief and confirmed targets. This core does not
claim that a candidate list is a feasibility proof or choose monthly targets.

Changing normalization can invalidate a reservation. It is then held for explicit
review rather than silently rebound to another counterparty or over-settled.
Freezing a current endpoint prevents projection/payment; an inactive intermediary
occurring only in previously normalized provenance does not. A completion during
a freeze remains held after reactivation. `release` cancels held/pending capacity;
a separately reviewed manual settlement can resolve already performed held work.

## Publication and persistence boundary

Publication commands include the expected live predecessor and immutable primary
duty snapshots. A combined weekend is compared as two half-point date atoms but
settles only at its real block end. Physical assignment-row IDs are absent.
Only shared old/new capacity automatically transfers; new/removed weight invents
no debtor. Explicit funded temporary/permanent intents have stable IDs and are
applied once. Do not add a second temporary intent for a transfer already derived
from a replacement. Permanent intent can exempt newly reviewed replacement units.

The pure TypeScript [allocation binder](ALLOCATION_PLANNER.md#pure-publication-binding)
also previews routed intents: one real final-primary capacity budget funds ordered
temporary/permanent legs, retaining original counterparts and source references.
An intermediate temporary creditor need not perform the final duty. Only temporary
legs create claims; permanent legs create none. Capacity is excluded once for the
whole route. Existing simple intents and their replay behavior are unchanged.
The [database integration](ALLOCATION_DATABASE.md) supports this contract in SQL,
with differential validation, authoritative source budgets and publication lineage.
The binder returns partial previews for review and rejects existing
publication histories requiring lineage decisions; it does not activate Publish.

Repayment cancellation is classified before ordinary replacement/swap effects.
Creditor substitution retains the original debt; third-party substitution routes
through that creditor. Separate ordinary capacity still transfers. A new intent
cannot recharge unchanged published capacity under a new ID. Publication copies
carry contribution IDs unchanged; resized plans cancel the old contribution and
use a new ID. A pure preview of the same source operation without reservations can
obtain post-transfer claim references before compiling the final operation.

Ordinary publication commands reject changes to completed facts. `mode: 'delete'`
may select a previously recorded immutable version, or drop the live pointer; it
preserves completed effects and never resurrects terminal contributions. Historical
corrections use explicit accounting operations, not a retroactive rota editor.

`projected.candidates` additionally exposes the simulated unreserved active slices,
including the exclusion of reservations after the cutoff. It reuses the same
availability calculation as `repaymentCandidates`, after simulated completion.

`reconcile` returns the full history with missing earned/hold events appended in
end-time/source order. `project(history, now, cutoff)` returns actual/reconciled
history separately from simulated claims/net; speculative events are never
returned as committed history. No timer job or wall-clock read exists in the core.

Database integration validates authority, canonical full coverage, eligibility,
consent and reviewed intent. It samples time after the workspace lock, checks
revision/fingerprint and atomically appends the missing event suffix. The single
`duty_compensation_events` table stores sequence, source key, server milliseconds,
actor, reason and operation. It has no balance columns or publication FKs.
Audit events/reasons are manager-only; private availability notes never enter
accounting snapshots.

`duty_balance()` is the read-only Team summary. It replays the ledger, simulates
due work and then every published contribution to the end of time on a private
copy (the same `compensation_reconcile(..., false)` used for `p_cutoff`), and
returns only `{net, lines}`. Nothing is appended and the revision is unchanged.
Admins receive every member; any other approved active member receives only
their own net and relationships. Lines describe open actual claims by source
lot (temporary intent date, published-change month, manual, correction, routed)
plus repayments that settle only in the projection; reasons, events and private
notes are never returned. `lib/supabase/balance.ts` validates the response.

`duty_compensation(p_operation, p_source_key, p_reason, p_revision,
p_fingerprint?, p_cutoff?)` accepts the five manual operations above or
`{kind: 'reconcile'}`. It requires an active approved manager before and after
the workspace lock. A manual key is namespaced by the authenticated actor.
Identical retries may use the original revision; changed content conflicts.
Manual source keys, reservation IDs and intent IDs use 1–160 ASCII letters,
digits or `_./:-` (the first character must be a letter or digit).
The caller cannot supply event sequence, actor, time, earned work or balances.
The response separates `actual`, optional `projected`, `actualAtMs`, `revision`
and an opaque database `fingerprint`. That fingerprint is for stale-plan checks,
distinct from the core's canonical `ledgerFingerprint`; neither grants access.

The existing schedule RPC optionally accepts `p_state.compensation` on Publish:
`{fingerprint, reservations, intents}`. The database derives publication ID,
owner, full primary snapshots and completion times. The reviewed fingerprint
must still match after due reconciliation. Ordinary publications/swaps carry
unchanged contribution IDs and intents; invalidated reservations cancel before
ordinary transfer accounting. Resizing a reservation requires an explicit new
ID and reviewed slice. Confirmed allocation months use server-compiled accounting
instead of client metadata. Draft persistence and scoped locks are described in
the [allocation database contract](ALLOCATION_DATABASE.md); UI and application
Generate integration remain future work.

The pointer hook records Publish, approved swaps and live-version deletion in
their existing transactions. Reopen/restore and Cancel Draft keep the live
commitment. Existing historical rota edits remain permitted: accounting retains
already completed facts rather than rewriting earned history. Explicit audited
corrections handle their compensation. Deleting a version retains all event
snapshots and terminal contributions. Participation changes reconcile under the
old active state before recording the new state; retrying onboarding cannot
freeze an existing participant.

The incremental migration starts every member at **zero compensation**, records
only initial participation/current publication facts, and advances a nonempty
workspace revision once. It does not import past imbalance, replay historical
versions, delete assignments, reset users or modify notes/requests. Invalid
off-half-point published weights fail the whole migration for explicit review;
no automatic cleanup runs. Hosted release still needs separate authorization
and the database-first release gates.

## Focused validation

`node --test tests/compensation.test.mjs` covers conservation, deterministic cycles,
transitive partial settlement, corrections/freezes, cross-month reservations,
completion/projection, copied/deleted publications, weighted swaps, cancelled and
permanent repayment replacements, deferral, weight changes and immutable history.
TypeScript and affected-file ESLint cover the public contracts. On an empty
disposable local database, run `compensation.sql`, `compensation-settlement.sql`,
and the `compensation-{parity,upgrade,races}.mjs <local-container>` scripts in
`supabase/tests/`. They cover the real permission/transaction boundary, complete
migration rollback and data preservation, exact-end earning, actual/projection
separation, frozen work, duplicate prevention and separate-session lock races.
SQL/core differential checks compare complete histories and graph provenance.
Quality runs these alongside existing publication/swap tests and canonical
fresh/upgrade gates. They do not establish allocation-solver feasibility.

Replay is intentionally uncached and proportional to ledger history; unusually
large ledgers should be measured before adding disposable projections. SQL and
TypeScript accounting must evolve together, retaining differential coverage.
