# Pure allocation planner

`lib/allocation/index.ts` implements the proposal and edit domain from
[the generation specification, sections 5–6](GENERATE_ALGORITHM.md). It has no UI,
storage, clock reads or RPCs. Application Generate injects
the existing HiGHS adapter and authoritative scheduling/accounting snapshots.

All allocation amounts are **integer half-point units**, including signed edits.
The scheduling source retains its existing calendar point format. The planner
converts units to points only when calling the existing scheduling validators.
Seniority is an explicit saved order, senior first, containing exactly the active,
approved, eligible participants (including an eligible manager).

```ts
import {proposeAllocation, editAllocation, compileAllocation, bindAllocation} from '../lib/allocation/index.ts';

const input = {schedule, seniority, events, now}; // schedule omits confirmed targets
const proposal = proposeAllocation(highsAdapter, input, {seconds: 10, seed: 17});
const edited = editAllocation(highsAdapter, input, proposal.draft, {
  id: 'reviewed-edit-1', engineer: seniority[0], deltaUnits: -2, kind: 'temporary',
});
// Actual generated/manually reviewed assignments, including null primary holes.
const final = compileAllocation(input, edited.draft, actualDraftAssignments);
const binding = await bindAllocation(input, edited.draft, actualDraftAssignments, {
  publicationId: 'reviewed-november', sourceKey: 'publish/reviewed-november', actor: 'manager',
});
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
4. Give equivalent baseline remainders newest first. Automatic +/- counterparts
   use the same order for Target and Permanent: a receiver has the fewest points,
   newest first; a giver has the most points, senior first.

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
crosses locked floors. The app only rearranges what it arranged itself: every
member the manager changed by hand is recorded in the draft's local `handEdited`
list, and automatic counterparts never take from or give to them. Members changed
only automatically stay re-adjustable, ranked as before. The list survives later
edits and Undo, resets with a new proposal, and is stripped before the checked
RPC persists the allocation. `transferAllocation` records one exact manual
transfer, such as a drag, without choosing a counterpart and protects both
members. `classifyTransfer` only changes a transfer's kind, so Make permanent keeps
targets and removes its future compensation. Partial-month probes require the recipient to carry the
increment relative to the prior witness without degrading its coverage priorities.
Unproved probes leave explicit pending edits; they are not labeled impossible.
The requested target is preserved when redistribution cannot finish. Subsequent
opposite edits of the same classification consume pending provenance first.
Pending edits prevent confirmation even when unrelated classifications happen
to offset numerically. Managers can explicitly finish a balanced partial table.

`assessAllocation` checks the supplied targets verbatim. It does not propose or
redistribute anything. Source, weight, membership, constraint, ledger or saved
seniority changes invalidate an old draft. Save the selected ordinary baseline
and counterpart provenance with the checked allocation snapshot.

`compileAllocation(input, draft, assignments)` independently validates the supplied
actual assignments against the confirmed targets and all scheduling rules. It
never calls a solver or substitutes a feasibility witness. Use `assessAllocation`
separately when feasibility advice is needed. Compilation validates component
conservation and source-slice exclusivity, then tracks ordinary and repayment
responsibility through counterpart transfers.
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
another posting or an executable settlement command. Each deferral
intent retains its original `deferredClaim`; `normalizedDeferredClaims` separately
explains the FIFO slices consumed by normalization. Original counterparts and
transfer IDs remain available rather than being rewritten to the final worker.
Ambiguous compound routes remain unbound and require explicit review before
confirmation. `unfundedUnits` retains all target shortfalls, and unassigned burden
creates no new claim.
Partial compilation uses exactly the assigned units, funding ordinary work before
oldest repayment and temporary burden. It does not optimize or fill missing work.

## Pure publication binding

`bindAllocation` returns the compiled plan, a pure `publication` snapshot, and a
`preview` from the existing compensation `record` transition. It never writes
events or earns settlement. `bindable` means the actual funded work passed the
accounting preview; `publishable` additionally requires complete actual coverage.
A partial snapshot is for review only; it cannot be sent to live Publish.

Each compiled `funding` route has one final carrier and one exclusive capacity
budget. For A→B temporary, B→C permanent, C's actual duty funds the route once:
A owes B, C receives no compensating claim, and B need not perform a duty.
Publication `route` legs retain their classifications, original counterpart
records, transfer IDs and original deferral source slices. Temporary chains may
collapse accounting endpoints while retaining every approved counterpart.

Binding uses chronological canonical date atoms, exact weighted half-point units,
and the real duty end for settlement. Combined weekends have two one-unit atoms
that both complete at Sunday handover. Transfer and repayment capacity never
overlap. Repayment sources must survive the actual publication preview, remain
unreserved across all months, and match the original path and aligned offsets.
SHA-256 identities derive from the explicit publication/source scope, allocation
source and bound capacity/content. Key ordering and retries preserve identities;
changed capacity or provenance creates new identities. No clock or randomness is read.

Ambiguous normalized deferrals, compound reverse obligations, unavailable reverse
sources, or changes that would hold another publication's repayment require
explicit review and return no executable publication. Binding a month with any
publication history also requires lineage review: the API does not synthesize
new allocation origins over already published work. Invalid assignments/stale
drafts retain the scheduling/allocation validator's errors.

The [database integration](ALLOCATION_DATABASE.md) now persists reviewed snapshots,
independently validates baseline/source budgets and scheduling, and supports routed
intents through the checked publication boundary. Use its typed context/confirmation/
save adapters; the database constructs authoritative accounting metadata itself.
The pure binder still requires lineage review for existing publication histories.
Application Generate uses `lib/allocation/client.ts` and `worker.ts` for proposals,
edits, checks and actual-assignment compilation. `reviewAllocation` validates a
saved table's provenance against captured facts without changing its numbers.
Manual review after opening projects through the later of opening/server time;
the separate generation cutoff still prohibits solving that month. Copied
publication intent remains under the checked database lineage rules.

## Focused verification

```sh
node --test tests/allocation-binding.test.mjs tests/allocation.test.mjs tests/compensation.test.mjs
pnpm exec tsc --noEmit
pnpm exec eslint lib/allocation lib/compensation/publication.ts lib/compensation/types.ts tests/allocation.test.mjs tests/allocation-binding.test.mjs
```

The tests cover canonical fairness, compensation-before-seniority, partial/blocked
oldest repayment, whole/half duties, availability relief, both adjustment kinds,
pending edits, deferral/netting, projected and future-reserved slices, locks,
partial months, weighted cross-year duties, boundaries, stale inputs and UNKNOWN.
Binding regressions additionally cover mixed routes with a nonperforming
intermediary, changed assignments, partial coverage, stable identities, original
versus normalized deferral slices, reverse obligations and overlapping/future reservations.
Real database/browser/mobile performance is outside these domain checks.
