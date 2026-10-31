# Pure allocation planner

`lib/allocation/index.ts` implements the proposal and edit domain from
[the generation specification, sections 5–6](GENERATE_ALGORITHM.md). It has no UI,
storage, clock reads or RPCs, and since 2026-10-30 no solver: proposals and edits are
synchronous arithmetic over the authoritative scheduling/accounting snapshot.
Generate is the only solver step and the exact feasibility check.

All allocation amounts are **integer half-point units**, including signed edits.
The scheduling source retains its existing calendar point format. The planner
converts units to points only when calling the existing scheduling validators.
Seniority is an explicit saved order, senior first, containing exactly the active,
approved, eligible participants (including an eligible manager).

```ts
import {proposeAllocation, allocationCeilings, editAllocation, compileAllocation, bindAllocation} from '../lib/allocation/index.ts';

const input = {schedule, seniority, events, now}; // schedule omits confirmed targets
const proposal = proposeAllocation(input);
const ceilings = allocationCeilings(input); // live inline availability check
const edited = editAllocation(input, proposal.draft, {engineer: seniority[0], deltaUnits: -2, kind: 'temporary'});
// Actual generated/manually reviewed assignments, including null primary holes.
const final = compileAllocation(input, edited.draft, actualDraftAssignments);
const binding = await bindAllocation(input, edited.draft, actualDraftAssignments, {
  publicationId: 'reviewed-november', sourceKey: 'publish/reviewed-november', actor: 'manager',
});
```

## Proposal (decision 2026-10-30)

`proposeAllocation(input)` is plain, deterministic arithmetic:

1. **Ordinary baseline.** Equal shares in the month's smallest duty step (whole
   points, or half points when the month has half duties); remainders go to the
   newest members. Availability and locks never change the baseline.
   The database accepts only an exact, minimum-squared-cost partition of the
   indivisible duty weights (`duty_private.allocation_baseline`). Weights follow
   the canonical calendar: a weekday is 1 + extra, a holiday weekend touched by a
   special range is one combined duty worth the sum of its two dates (each adding
   its own extra), and a hand-split holiday weekend keeps each date's own points.
   When duties are lumpy (for example 14 days at +2 among 12 engineers with the
   weekends split by hand: equal 4.5 each is impossible), `fitPartition` in
   `lib/allocation/fit.ts` runs a small exact
   search over duty counts, with no solver, and the larger shares go to the
   newest members. The dialog then shows one note naming who gets more. The
   search is capped; a pathological calendar shows a clear message
   (`allocation-fit-limit`) instead of freezing. The database's own optimality
   proof is slower: about 8 s locally for that 14-day case, which is the
   hosted `authenticated` statement timeout.
   **Uneven credit (decisions 2026-10-30 and 2026-10-31).** The people who carry
   more are compensated: `unevenTransfers` records the fitted baseline's excess
   over the plain equal split as system temporary transfers in `draft.uneven`
   (`uneven/<debtor>/<creditor>`, half-point units). The baseline is compared
   rank by rank with the sorted plain split, so a remainder given to a different
   member never creates debt; only the fit's deviation does. Debtors are the
   members with the fewest points, most senior first; creditors have the most
   points, most senior first. In the 14-day case each of the six most senior
   members owes half a point to one of the six newest. The credit follows the
   real permanent load: a creditor is credited only for the extra it still
   carries after its net permanent loss, and a debtor owes only while it still
   sits below the split after its net permanent gain (audit R3: Permanent −0.5
   on a creditor lands on its debtor, both reach the equal share, and the credit
   disappears). Temporary changes carry their own compensation and leave the
   credit alone. Targets and the stored baseline are unchanged; compilation
   carries part of the creditor's own share for the debtor, exactly as if the
   equal split had been transferred, so publication creates the ordinary
   temporary claim and later repayment settles it. Relief for an existing claim
   never consumes work carried this way. The credit is derived, never chosen:
   proposals, edits and review recompute it from the baseline and the
   per-person changes under the current seniority, and the checked database
   derives the same list and refuses any other.
2. **Repayment.** Open projected obligations are repaid oldest first, in whole
   steps, capped by the debtor's availability ceiling (below) and by the
   creditor's locked floor. An older claim that does not fit is skipped and stays
   open; a younger one may still progress. There is no fixed monthly cap.
3. **Locks are floors.** A member below their locked points takes temporary work
   from the member with most points, most senior on ties, as part of the
   automatic balance below.

Unavailable members keep their fair baseline; the manager moves their work
(the row warns) and Generate keeps a partial result when targets cannot be met.

**Availability ceiling.** `allocationCeilings` gives each member the most units of
duties they may take: covered duties they are available for and that are not
locked to someone else, with no two back-to-back duties unless approved, and never
below their own locked points. It ignores weekend caps, neighbors and shared
capacity, so it is a live hint, not a proof. The dialog recomputes it on every
change and shows one short warning on a row whose target exceeds it. It never
blocks; Generate remains the exact check.

### Superseded: solver-proven allocation preview

Until 2026-10-30 the dialog ran HiGHS in a Worker on open and after every edit to
prove a lexicographic optimum (fairness, coverage, repayment, minimum relief,
seniority) and a feasibility witness, and showed complete/partial/unknown status.
That preview was slow and complex and is superseded by the arithmetic above. The
allocation Worker is removed; `compileAllocation` runs synchronously after Generate.

## Per-person changes (decision 2026-10-31)

The draft holds one net **Temporary** and one net **Permanent** change per member
(`changes`, signed half-point units), the explicit drag `pairs`, and the derived
`transfers`. Points = offered (fair baseline plus planned repayments) + Permanent +
Temporary. Nothing records a history of clicks: `editAllocation` sets the member's
net change of that kind to what the row showed plus the delta, marks the member
hand edited, and rebuilds everything derived. The **automatic balance**
(`balanceChanges` in `lib/allocation/derive.ts`) is recomputed from scratch on
every edit: lock floors first, then each kind's hand total (permanent first) is
placed on members without hand changes in duty steps, refreshing the ranking after
each step: receivers have the fewest points, newest first; givers the most points,
senior first; a member already balancing the other kind comes last; locks are
never crossed. So the same per-person state gives the same table whatever the
click order, an automatic point never sticks on a member later edited by hand (a
minus on a member holding only an automatic point removes it and the point moves
on), and hand changes never cancel each other implicitly; a drag routes a specific
point. What cannot be placed stays visible as unplaced and blocks confirmation.

**Floors.** fair + Permanent ≥ 0, and a permanent reduction never exceeds the
member's planned work (offered + Permanent ≥ 0: relief already planned cannot be
given away); Points ≥ Locked. The dialog disables a button at its floor; the
library and the database refuse past it. Temporary credit is the positive net
Temporary only, so a member is owed exactly the work above their planned load.

`transferAllocation` records a drag as a pair, moving both members' nets by its
units and protecting both. `classifyTransfer` switches a pair's kind, moving the
nets between kinds, so Make permanent keeps points and removes its future
compensation. `deriveTransfers` builds the canonical list kind by kind (permanent
first): pairs in order, clipped to the nets they can still route, then the
remainder netted largest first, then seniority order; one transfer per direction,
and round trips cancel in the nets. The checked RPC re-derives that list and
requires it exactly. `hand` is local editing state, stripped before persisting;
a reopened draft treats every member with a nonzero change as hand edited. A new
proposal reapplies the retained hand changes and pairs of members still present
when they fit the floors (`retainedChanges`); otherwise the plain proposal stands.
It also keeps the confirmed ordinary baseline when that is still the same
partition of the month's duties, so a seniority reorder after confirmation never
forces a different baseline onto the next proposal (the database keeps a confirmed
baseline immutable while duties and participants stand); `reviewAllocation`
re-derives the uneven credit under the current order, so the retained draft still
confirms.

Source, weight, membership, constraint, ledger or saved seniority changes
invalidate an old draft. Save the selected ordinary baseline, the per-person
changes, pairs and derived transfers with the checked allocation snapshot.

`compileAllocation(input, draft, assignments)` independently validates the supplied
actual assignments against the confirmed targets and all scheduling rules. It
never calls a solver or substitutes a feasibility witness. Compilation validates component
conservation and source-slice exclusivity, then tracks ordinary and repayment
responsibility through counterpart transfers.
A transfer out of a member takes planned repayment tokens (newest first) only
as far as that member's target was lowered; a change that keeps the target moves
ordinary responsibility and never consumes planned repayment work. Remaining
capacity funds oldest repayment first. Temporary chains collapse to their approved endpoint
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
Plan the month calls the planner, edits and `compileAllocation` synchronously;
only Generate's own scheduling Worker runs HiGHS. `reviewAllocation` validates a
saved table's provenance against captured facts without changing its numbers.
Manual review after opening projects through the later of opening/server time;
the separate generation cutoff still prohibits generating that month. Copied
publication intent remains under the checked database lineage rules.

## Compensation display

"Adjustments & compensation" lists netted temporary relationships only
(`nettedCompensation` in `lib/allocation/netting.ts`), built from the **compiled**
plan (`planAllocation`: the same compilation as if every confirmed point were
worked). It starts from the projected net at month opening, adds the plan's
temporary intents (including deferred repayment carried for a creditor) and
subtracts the plan's repayments, then pairs net debtors with net creditors.
Chains collapse (A owes B and B owes C shows A → C), opposite directions cancel,
and each line shows what is really repaid this month and what carries forward.
Half points follow the same rules (decisions 2026-10-31): a half-point debt is
never rounded, forgiven or expired, and halves net across people, so if A owes B
0.5 and C owes A 0.5 the list shows C → B 0.5 and A is clear. That netting is
not a display convention: it is the ledger's own normalization (opposing, cycle
and chain steps in `lib/compensation/normalize.ts`, mirrored exactly by
`duty_private.compensation_normalize`), applied to every open claim on every
ledger change, and the per-member netting here reproduces it for the plan. Only
open halves net; a settled half never moves, and a half already reserved for
repayment still nets, with its reservation held for review. A lone half, the odd
half-unit that carries forward with nothing to pair it, says "0.5 waiting for the
second half" (`loneHalf`) in place of "0.5 later": whole duties cannot repay it,
so it waits for a second half or for a month with half-point duties. The Team
breakdown adds the same line to a relationship whose net is a lone half.
A line whose own direction carries an indivisible month's extra says "uneven
split" (`reason`); the Team screen's net breakdown names the same credit
"Uneven monthly split" (`duty_balance` kind `uneven`).
Permanent intents and unplaced changes do not appear; unplaced units show one
short warning line. The list is display only: stored changes, repayments, ledger
and provenance are unchanged.

## Focused verification

```sh
node --test tests/allocation-binding.test.mjs tests/allocation.test.mjs tests/allocation-netting.test.mjs tests/compensation.test.mjs
node --test tests/allocation-fuzz.test.mjs   # FUZZ_SEQ, FUZZ_LEN, FUZZ_SEED widen the bounded run
pnpm exec tsc --noEmit
pnpm exec eslint lib/allocation lib/compensation/publication.ts lib/compensation/types.ts tests/allocation.test.mjs tests/allocation-binding.test.mjs
```

The tests cover canonical fairness, compensation-before-seniority, partial/blocked
oldest repayment, whole/half duties, availability ceilings, both change kinds,
order independence, hand-edit protection, unplaced changes, the floors, pairs and
the canonical derivation, deferral/netting, projected and future-reserved slices,
locks, partial months, weighted cross-year duties, boundaries and stale inputs. The
fuzz regression replays random edit, drag, Make permanent and Undo sequences and
checks floors, conservation, canonical transfers, state determinism, compilation
and ledger parity after publication.
Binding regressions additionally cover mixed routes with a nonperforming
intermediary, changed assignments, partial coverage, stable identities, original
versus normalized deferral slices, reverse obligations and overlapping/future reservations.
Real database/browser/mobile performance is outside these domain checks.
