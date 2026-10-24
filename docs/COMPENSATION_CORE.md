# Pure compensation core

`lib/compensation/index.ts` implements the accounting part of
[the authoritative specification](GENERATE_ALGORITHM.md), independently of UI,
allocation solving, storage and authorization. Application Generate, publication
and swaps do not import it. There are no migrations or RPC changes.

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
The future allocation planner must choose oldest-feasible amounts using global
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

`reconcile` returns the full history with missing earned/hold events appended in
end-time/source order. `project(history, now, cutoff)` returns actual/reconciled
history separately from simulated claims/net; speculative events are never
returned as committed history. No timer job or wall-clock read exists in the core.

Future database integration must validate authority, canonical full coverage,
eligibility, consent and reviewed intent; sample time after the workspace lock;
check revision/fingerprint; and atomically persist only the missing event suffix
with source uniqueness and publication metadata. One append-only event table is
sufficient; caches are disposable. Event snapshots must survive publication-row
deletion, and private notes must stay outside compensation payloads. Manager-only
audit reasons and member-visible summaries require separate adapter projections.

## Focused validation

`node --test tests/compensation.test.mjs` covers conservation, deterministic cycles,
transitive partial settlement, corrections/freezes, cross-month reservations,
completion/projection, copied/deleted publications, weighted swaps, cancelled and
permanent repayment replacements, deferral, weight changes and immutable history.
TypeScript and affected-file ESLint cover the public contracts. These checks do
not establish database authorization, concurrent transaction safety or allocation
solver feasibility; those integrations remain future work.
