# Pure allocation planner

`lib/allocation/index.ts` implements the proposal and edit domain from
[the generation specification, sections 5–6](GENERATE_ALGORITHM.md). It has no UI,
storage, clock reads, RPCs or connection to application Generate. Callers inject
the existing HiGHS adapter and authoritative scheduling/accounting snapshots.

All allocation amounts are **integer half-point units**, including signed edits.
The scheduling source retains its existing calendar point format. The planner
converts units to points only when calling the existing scheduling validators.
Seniority is an explicit saved order, senior first, containing exactly the active,
approved, eligible participants (including an eligible manager).

```ts
import {proposeAllocation, editAllocation, compileAllocation} from '../lib/allocation/index.ts';

const input = {schedule, seniority, events, now}; // schedule omits confirmed targets
const proposal = proposeAllocation(highsAdapter, input, {seconds: 10, seed: 17});
const edited = editAllocation(highsAdapter, input, proposal.draft, {
  id: 'reviewed-edit-1', engineer: seniority[0], deltaUnits: -2, kind: 'temporary',
});
const final = compileAllocation(highsAdapter, input, edited.draft);
```

## Proposal priorities and proof

The ordinary baseline is a partition of canonical indivisible duty weights.
One-hot totals express the exact cost `sum((n * B[e] - P)^2)`. Personal
availability and locks do not erase ordinary responsibility. Locks remain final
target floors; increases beyond offered work require explicit classification.

After proving minimum ordinary cost, retain all equivalent baseline vectors and:

1. Maximize attainable covered dates, marked special dates, then assigned units.
2. Maximize each projected unreserved obligation's repayment, oldest first,
   permitting partial units and continuing past an infeasible older claim.
3. Minimize explicit temporary availability relief.
4. Give equivalent baseline remainders newest first, then select temporary
   counterparts in forward/wrapping saved seniority order.

Each objective is fixed only after proof. There is no weighted approximation of
these priorities and no fixed monthly repayment cap. Creditor relief, debtor
work, nonnegative targets, locks and actual canonical combinations bound payments.
The compensation-adjusted offered table also partitions physical duty weights;
automatic relief cannot round an otherwise indivisible half-point repayment by
creating an extra temporary burden. Repayment is funded beyond the debtor's
ordinary share; a temporary recipient cannot finance fictitious repayment.

The assignment constraints come directly from the scheduling `buildModel` with
variable ceilings: availability over every covered date, identity/secondary
exclusion, weekends, adjacency, neighbors, locks and specifically scoped approvals.
All witnesses pass model-row checks and the independent scheduling domain
validator. Placement spacing/preferences/randomness remain Generate's concern.

One time/node budget covers all stages within a public operation, including edit
counterpart probes. The maximum is 30 seconds. `optimal` and individual stage
proofs are separate from `complete`, `partial`, `unknown` or `invalid` feasibility.
A complete witness proves possibility; a proved coverage optimum below full
coverage proves partial necessity. A timeout never proves impossibility.

## Editing and final compilation

`editAllocation` clones the draft, tries the whole change before half-point
redistribution, refreshes donor/recipient ranking after each transfer and never
crosses locked floors. Partial-month probes require the recipient to carry the
increment relative to the prior witness without degrading its coverage priorities.
Unproved probes leave explicit pending edits; they are not labeled impossible.
The requested target is preserved when redistribution cannot finish. Subsequent
opposite edits of the same classification consume pending provenance first.
Pending edits prevent confirmation even when unrelated classifications happen
to offset numerically. Managers can explicitly finish a balanced partial table.

`assessAllocation` checks the supplied targets verbatim. It does not propose or
redistribute anything. Source, weight, membership, constraint, ledger or saved
seniority changes invalidate an old draft. Save the selected ordinary baseline
and counterpart provenance with the future allocation snapshot.

`compileAllocation` validates component conservation and source-slice exclusivity,
then tracks ordinary and repayment responsibility through counterpart transfers.
Lowered debtor targets defer newest repayment first; remaining capacity funds
oldest repayment first. Temporary chains collapse to their approved endpoint
trail. Third-party deferral creates creditor-to-carrier intent, preserving the
original debt rather than creating a second debtor shortfall. Permanent transfers
remain exempt from new claims and do not settle/forgive the old debt. Temporary
work that can repay an existing reverse obligation is classified as repayment,
preventing premature opposing-claim cancellation on publication.

Funded temporary intent is normalized in a pure preview before repayment source
slices are selected. This matters because a chain bypass consumes the oldest
prefix of an existing source. Reservations use surviving unreserved slices of
the same obligation, never the old consumed prefix. `deferred` explains outstanding
opening-source slices, including those referenced by a rerouted intent; it is not
another posting or an executable settlement command. Both repayment and deferral
intent references follow the normalized slices. Ambiguous compound routes remain
unbound and require explicit review before confirmation. `unfundedUnits`
retains all target shortfalls, and unperformed burden creates no new claim.
For partial tables, compilation preserves coverage priorities and then optimizes
oldest repayment funding before choosing its witness; it does not defer feasible
compensation because of an arbitrary equally covered assignment.

These are point plans, **not publication payloads**. Future integration must bind
funded intent and repayment to exclusive real duty/date-atom capacity with stable
IDs, preview the authoritative publication transition, and use the existing
revision/fingerprint-checked publication API. Draft compilation never creates
events or earns settlement. Review/confirmation, execution in a cancellable Worker,
publication binding and persistence are subsequent integration work.

## Focused verification

```sh
node --test tests/allocation.test.mjs tests/generation.test.mjs tests/highs-spike.test.mjs tests/compensation.test.mjs tests/engine.test.mjs tests/snapshot.test.mjs
pnpm exec tsc --noEmit
pnpm exec eslint lib/allocation lib/scheduling/solver/model.ts lib/compensation/ledger.ts tests/allocation.test.mjs
```

The tests cover canonical fairness, compensation-before-seniority, partial/blocked
oldest repayment, whole/half duties, availability relief, both adjustment kinds,
pending edits, deferral/netting, projected and future-reserved slices, locks,
partial months, weighted cross-year duties, boundaries, stale inputs and UNKNOWN.
Real database/browser/mobile performance is outside these domain checks.
