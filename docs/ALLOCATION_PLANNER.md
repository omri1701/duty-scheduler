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
const ceilings = allocationCeilings(input); // spaced ceiling: no back-to-back duties
const edited = editAllocation(input, proposal.draft, {engineer: seniority[0], deltaUnits: -2, kind: 'temporary'});
// Actual generated/manually reviewed assignments, including null primary holes.
const final = compileAllocation(input, edited.draft, actualDraftAssignments);
const binding = await bindAllocation(input, edited.draft, actualDraftAssignments, {
  publicationId: 'reviewed-november', sourceKey: 'publish/reviewed-november', actor: 'manager',
});
```

## Proposal (decision 2026-10-30)

`proposeAllocation(input)` is plain, deterministic arithmetic:

**One extra each, before anyone gets two (decision 2026-11-01).** A member's
extra point this month is either a larger ordinary share (a remainder) or a point
of repayment. Nobody gets a second remainder until every eligible member has one
extra, and among a creditor's debtors nobody repays a second point before every
one of them has repaid one (2 below).

1. **Ordinary baseline.** Equal shares in the month's smallest duty step (whole
   points, or half points when the month has half duties); remainders go to the
   newest members who are not repaying this month, and only then, newest first,
   to repayers. Availability and locks never change the baseline's shares. Only
   when a lock makes that arrangement impossible to schedule (a locked 2.5-point
   holiday day needs an odd share) do two members swap shares, nearest in that
   order first (decision 2026-11-01). Who repays
   depends on the creditors' shares and the reverse, so the proposal settles both
   (a creditor's own remainder adds to its relief).
   The database accepts only an exact, minimum-squared-cost partition of the
   indivisible duty weights (`duty_private.allocation_baseline`). Weights follow
   the canonical calendar: a weekday is 1 + extra, a holiday weekend touched by a
   special range is one combined duty worth the sum of its two dates (each adding
   its own extra), and a hand-split holiday weekend keeps each date's own points.
   When duties are lumpy (for example 14 days at +2 among 12 engineers with the
   weekends split by hand: equal 4.5 each is impossible), `fitPartition` in
   `lib/allocation/fit.ts` runs a small exact
   search over duty counts, with no solver, and the larger shares go to the
   same members as remainders. The dialog then shows one note naming who gets more. The
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
2. **Repayment in turns.** Each creditor's relief this month (its share above its
   locks, so it never goes below them or below 0, and never work carried as uneven
   credit) is repaid by its own debtors **in turns**: one point at a time to the
   debtor who has repaid least of its current debt to that creditor (repayment
   work already published counts), **newest member first** on ties, each from its
   own oldest debt, within its availability ceiling (below). A second round starts
   only after every debtor of that creditor who still owes has had one, and the
   turns carry on into the next month. Creditors are served in the order of their
   oldest debt, each with its own turns. A single debtor repays as much as the
   relief allows (A owes B two points: A +2, B −2 this month). The rest carries
   over and is never forgiven. Examples: in the reported January, Shira and Omer
   repay Local Admin one point each, instead of Tamar repaying both; B, C and D
   owing A two points each, with A's share at three points, repay one point each
   in November and again in December; with A's share at two, D and C repay in
   November and B goes first in December.
   A turn never leaves the month unable to give every member exactly its points
   (decision 2026-11-01, `partitionable`): each member keeps its locked duties and
   every other duty must go to someone. Half a point changes which members need
   a half duty (a split weekend half, or a holiday day worth x.5 points), and the
   month has only so many, so a step that would break the split shrinks to half a
   point or passes to the next debtor. A creditor relieved down to 0.5 in a month
   with no half duty keeps 1 instead. Before, such proposals were partial at
   Generate.
3. **Locks are floors.** A member below their locked points takes temporary work
   from the member with most points, most senior on ties, as part of the
   automatic balance below.
4. **Non-weekend members (decision 2026-11-01).** A member the admin marked
   "No weekends" in Team gets **+1 Permanent** (`NON_WEEKEND_UNITS`, no repayment:
   their standing extra for skipping weekends) as a hand change, so the automatic
   balance takes the point from the others, one step per member as usual, and the
   total stays the month total. The admin can still edit or remove it that month;
   an edit (even back to zero) keeps the member in the hand state, so a fresh
   proposal never re-adds it. The default is left out when it would break a floor
   or the month cap (fair + Permanent ≤ total), exceed the member's availability
   ceiling, find no counterpart, or leave an exact month unable to give everyone
   exactly its points (the same `partitionable` check as a repayment turn). A saved plan is never changed: turning the
   setting on applies from the month's next fresh proposal. The row shows
   "No weekends · +1" (the member's current Permanent), and a short warning when a
   weekend locked to them is kept. The checked confirmation needs nothing new: the
   change is an ordinary per-person Permanent change.

Unavailable members keep their fair baseline; the manager moves their work
(the row warns) and Generate keeps a partial result when targets cannot be met.

**Availability ceilings.** `availableCeilings` (`lib/allocation/model.ts`) gives each
member the units of every duty they may take: covered duties they are available
for, not locked to someone else and not overlapping their own duty in a neighbouring
month (touching it is a back-to-back day), never below their own locked points. Generate fills such a target with
back-to-back duties and extra weekends as a last resort, so this is the hard
ceiling. `allocationCeilings` is the spaced ceiling: the same duties without two
back-to-back duties unless approved; automatic repayments stay within it. Both
ignore shared capacity, so they are live hints, not proofs. The dialog recomputes
them on every change; above the hard ceiling a row warns "Availability allows
about N", between the two it notes "This needs some back-to-back days". Neither
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
never crossed. Receivers take one step per round (decision 2026-10-31): a −2 gives
one point to each of two members rather than two to one. So the same per-person state gives the same table whatever the
click order, an automatic point never sticks on a member later edited by hand (a
minus on a member holding only an automatic point removes it and the point moves
on), and hand changes never cancel each other implicitly; a drag routes a specific
point. An edit whose counterpart cannot be placed is refused (see Month bounds).

**Floors.** fair + Permanent ≥ 0, and a permanent reduction never exceeds the
member's planned work (offered + Permanent ≥ 0: relief already planned cannot be
given away); Points ≥ Locked. The dialog disables a button at its floor; the
library and the database refuse past it. Temporary credit is the positive net
Temporary only, so a member is owed exactly the work above their planned load.

**Ceiling.** fair + Permanent ≤ the month's total points, so a member's Permanent
is at most the month total minus their fair share (`permanentCeiling`, decision
2026-10-31): with a fair share of 2 in a 26-point month, at most +24. Permanent + is
a punishment: the member does more and the others are relieved for free. Mixing
+ Permanent and − Temporary on one member stays allowed (they work more for good and
the others cover the deferred part now) up to the ceiling. The library refuses an
edit, drag or Make permanent that would pass it (`permanent-above-month-total`) and
never applies part of a step: half a point below the ceiling a one-point step is
refused, a half-point step still applies. The automatic balance never chooses a
permanent receiver past it, and the dialog disables Permanent + at the ceiling with
the note "Max punishment here is +24 (26 points this month)". The database checks
the same ceiling.

**Month bounds** (audit 2026-10-31). The configured total always equals the month
total, before and after Generate and after Save → reopen. An edit or drag whose
counterpart no one can absorb is refused, never left unplaced
(`unplaced-allocation-change`; above the total, `allocation-above-month-total`).
One exception (decision 2026-11-01): when no one free can take a − on a member who
received dragged points (or a + on one who gave them), the member's own drags of
that kind are undone, newest first, so the points go back to whoever they came
from. A month where everyone dragged their points onto one member can then be
lowered with − instead of being stuck.
Before, a two-member team could press + until 77 / 26 points, and a − with no
counterpart left the plan short. No member's net Temporary exceeds the month total
either way (`temporary-above-month-total`; the database checks it too). With these,
every member's points stay between locked and the month total. `editOptions`
reports which + and − the library accepts at the current step, and the dialog
disables the rest with a screen-reader note ("No one else can take on less. Drag a
point instead." / "No one else can take this point. Drag a point instead.").
A plan saved before this rule that is still unbalanced may only move toward
balance.

`transferAllocation` records a drag as a pair, moving both members' nets by its
units and protecting both. `classifyTransfer` switches a pair's kind, moving the
nets between kinds, so Make permanent keeps points and removes its future
compensation. `deriveTransfers` builds the canonical list kind by kind (permanent
first): pairs in order, clipped to the nets they can still route, then the
remainder netted largest first, then seniority order; one transfer per direction,
and round trips cancel in the nets. The checked RPC re-derives that list and
requires it exactly. `hand` (the members edited by hand) persists with the plan,
so after Save → reopen, or Generate and reopen, automatic points keep flowing
exactly as in the session that saved it. A plan saved before `hand` was stored
infers it on review (`inferHand`): starting from every changed member and every
dragged pair's members, it drops members newest first while the automatic balance
of the rest still reproduces the saved changes. Before, a reopened plan froze every
changed member, so in a two-member team a − had no one to give the point to. A new
proposal reapplies the retained hand changes and pairs of members still present
when they fit the floors and the ceiling (`retainedChanges`); otherwise the plain proposal stands.
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
preventing premature opposing-claim cancellation on publication. The same holds for
a deferred repayment (decision 2026-10-31): when B's lowered target hands B's
repayment to C over to D, and D owes C too, the point repays D's own oldest open
debt to C. B's debt stays open, D's drops, nothing new is owed to D, and the units
repaid to C are unchanged. Only when D's open debt runs out does the plan need review.

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
confirmation. Permanent legs owe nothing (decision 2026-11-01): a reverse leg after
only permanent legs is the debtor's own repayment (A gives C a point for good, C
hands it to D who owes C: D repays C), and a route back to its own carrier drops
the permanent legs out of it. Plan the month names any review code with its own
note and keeps **Confirm & generate** disabled until the plan can be booked, so a
plan never fails as a whole after Generate. `unfundedUnits` retains all target shortfalls, and unassigned burden
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
node --test tests/non-weekend.test.mjs   # non-weekend default, caps, Generate eligibility and rotation
node --test tests/allocation-fuzz.test.mjs   # FUZZ_SEQ, FUZZ_LEN, FUZZ_SEED widen the bounded run
node --test tests/allocation-months.test.mjs   # several months published in a row; MONTHS_SEQ, MONTHS_LEN
node --test tests/allocation-lifecycle.test.mjs   # extremes, back to fair, re-plan, delete, later months; LIFE_SEQ, LIFE_LEN
node --test tests/messages.test.mjs   # every error code and server sentence has an English and Hebrew message
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
