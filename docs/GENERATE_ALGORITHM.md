# Monthly Duty Generation Algorithm Specification

## 1. Purpose and scope

This is the product and engineering source of truth for the **future redesign**
of monthly primary-duty generation. It records agreed requirements, distinguishes
them from current behavior, and identifies requirements whose implementation
depends on a further product or mathematical decision.

**The manager decides workload allocation. The algorithm decides the best dates
for that allocation.**

The system must be mathematically reliable, fair across engineers and months,
strict about automatic scheduling constraints, transparent to managers, and
efficient enough for interactive use. It must support approximately 12 engineers
as the typical case, as well as smaller and larger teams, including two engineers.
Supporting a team size means correctly solving or explaining that team's model;
it does not guarantee feasibility under contradictory rules.

The manager may deliberately override the specifically permitted rules through
manual locks. The solver must never silently change exact point targets, drop
locks, violate hard constraints, or report incomplete coverage as success.

### 1.1 Status of statements

| Label | Interpretation |
|---|---|
| Required behavior | Agreed behavior for the redesign; mandatory unless an explicitly described manager override applies. |
| Current behavior | Observation from the inspected repository; not a claim that a future feature exists today. |
| Conceptual model / preferred direction | A possible engineering realization to assess before implementation; not a package or architecture approval. |
| Not yet determined | The supplied requirements do not select one policy or formula. Implementation must not silently choose one. |

This document does not implement scheduling, storage, UI, or database changes.
It does not authorize a new dependency, service, paid API, AI inference,
deployment, permission change, or historical schedule rewrite. It does not
replace unrelated application, database, or release documentation.

### 1.2 Evidence and references

Current-state observations were checked against `develop` commit
`b29b4dcb157cb678429ff091d7f6f5c84e84f1d7` on 22 October 2026.
They describe repository behavior, not an independently verified hosted deployment.

| Area | Relevant evidence |
|---|---|
| Duties, ownership, points, generation, weekends and draft swaps | [Scheduling engine](../lib/rota/engine.ts), especially `blocks`, `ownerMonth`, `generate`, `totals`, `weekendCounts` and `swapDraft); [engine tests](../tests/engine.test.mjs). |
| Calendar ownership and scoped updates | [Calendar dates](../lib/rota/calendar-dates.ts), [workspace projections](../lib/rota/workspace-data.ts), [workspace tests](../tests/workspace-data.test.mjs) and [calendar tests](../tests/calendar-layout.test.mjs). |
| Generation, manual edits and Special Blocks in the current UI | [Draft workflow](../hooks/use-workspace-draft.ts), [duty editor](../components/rota/duty-editor.tsx) and [workspace dialogs](../components/rota/workspace-dialogs.tsx). |
| Draft/publication selection and persistence payloads | [Snapshot conversion](../lib/supabase/snapshot.ts) and [snapshot tests](../tests/snapshot.test.mjs). |
| Database duty invariants and checked writes | [Assignment schema](../supabase/schemas/tables/duty_assignments.sql), [schedule save/publication](../supabase/schemas/functions/duty_private/save_schedule.sql) and [revision check](../supabase/schemas/functions/duty_private/check_revision.sql). |
| Published swaps and actual workload | [Swap validation](../supabase/schemas/functions/duty_private/validate_swap.sql), [swap resolution](../supabase/schemas/functions/duty_private/resolve_swap.sql), [swap tests](../tests/swaps.test.mjs) and [SQL swap regressions](../supabase/tests/swaps.sql). |
| Existing product, runtime and security context | [README scheduling rules](../README.md#scheduling-rules-and-defaults), [Supabase setup](SUPABASE_SETUP.md) and [package commands](../package.json). |

## 2. Current behavior versus required behavior

The existing pure TypeScript engine is independent of UI and storage. Preserve
that separation when designing the replacement.

| Concern | Current behavior | Required redesign |
|---|---|---|
| Search | Exactly 90 seeded heuristic attempts, scored with soft penalties and rewards; selection among near-best candidates. | Constraint-based global feasibility followed by the agreed spacing objectives. |
| Workload allocation | No pre-generation target table or exact per-engineer target constraints. Weighted load balancing happens while assigning dates. | Manager reviews and controls strict targets before date assignment. |
| Seniority | Active team order runs senior to newest. Heuristic weights are `1 + 0.22 × i / max(1, n − 1)`, from 1.00 to 1.22, plus a soft preference for newer engineers receiving indivisible remainder. | Retain the slight preference toward newer engineers, with exact half-point/integer targets and historical compensation. The new formula is not approved here. |
| History | Each month balances independently; past workloads and gaps do not affect generation. | Persistent temporary compensation and primary-duty boundary context. |
| Unavailability | Automatic primaries respect every covered unavailable date. An impossible duty can remain empty with a warning. | Preserve automatic availability protection; establish complete feasibility and never label an incomplete schedule successfully generated. |
| Consecutive duties | Allowed; short spacing is a soft penalty. | Forbidden for automatic assignments, including boundaries and split weekends. |
| Locks | `Assignment` retains a legacy optional `locked` field, but generation ignores it; old migration logic removes obsolete locks. No current manager Lock/Unlock feature or persisted lock field in schedule payloads exists. | Explicit, durable manager locks preserved by Generate and Regenerate. |
| Manual primaries | Regeneration replaces primaries in the selected owner's month, including manual edits. | Preserve locked primaries; treatment of manually edited but unlocked primaries remains to be decided. |
| Emergency cover | Preserved, but contributes full duty points to current totals/load, spacing and weekend counts. Generation excludes that duty's secondary from primary candidates. | Preserved and excluded from primary workload, fairness, spacing, consecutiveness and regular weekend limits. Reconcile the existing same-person integrity rule before implementation. |
| Weekends | Friday ownership; combined weekend worth 1; separate halves worth 0.5 each. Automatic primary selection obeys a distinct-weekend cap that also considers existing secondary coverage. | Preserve ownership and duty weights; apply the regular cap to primary duties only, with no unapproved exception. |
| Special Blocks | Daily extra points; a special overlapping a weekend makes its Friday/Saturday separate blocks. Engine tests exercise ranges spanning months. Current UI creation restricts a range to the selected month's owned duties, up to 14 dates and 0–20 extra per date, and clears touched assignments. | Support cross-month Special Blocks, require 0.5 increments, preserve ownership and locks, and reconcile changed duty totals with strict targets. Cross-owner editing workflow is not specified here. |
| Exact arithmetic | JavaScript numbers in the engine; SQL `numeric` points generated from duty dates and extra points. The database range check does not enforce 0.5 increments. | Exact half-point arithmetic throughout the allocation and solver model. |
| Persistence | Checked, revision-protected writes; mutable draft rows separate from immutable publication versions. | Preserve these protections while adding allocation, fairness and lock information in a future reviewed design. |

Existing tests deliberately assert several behaviors that this redesign changes:
legacy locks are replaced; previous-month loads have no effect; emergency cover
earns points; an impossible duty remains unassigned; and a two-engineer fixture
leaves three of five weekends open. These are accurate descriptions of today's
contract, not acceptance criteria for the replacement.

Current publication/swaps already protect primary/secondary identities, active
approved membership, availability, version history and revisions. Draft manager
edits can explicitly approve availability or additional-weekend exceptions.
Published swap approval has its own stricter weekend checks. The redesign must
not infer a general permission to bypass those protections.

## 3. Terminology and duty model

| Term | Meaning |
|---|---|
| Primary duty / duty block | One required coverage interval with exactly one primary engineer in a complete schedule. |
| Normal duty | One daily interval, normally 09:00 on its date through 09:00 the next day. |
| Combined weekend | One Friday 09:00 through Sunday 09:00 primary-duty block, displayed as Friday–Saturday. |
| Split weekend | Separate Friday 09:00–Saturday 09:00 and Saturday 09:00–Sunday 09:00 blocks, with a shared Friday weekend identity. |
| Special Block | A configured range adding extra points to covered daily duties; not one indivisible multi-day assignment. |
| Owner month | The month responsible for assigning and accounting for a duty. Friday owns both weekend halves. Other duties belong to their date's month. |
| Displayed date | A calendar label; it does not replace the duty's actual covered interval or ownership. |
| Emergency / secondary assignment | Optional extra coverage, possibly only for an hour, separate from primary-duty scheduling. |
| Final target | Exact primary-duty points an engineer must receive in the selected month, including temporary and permanent adjustments. |
| Locked assignment | A manager-fixed primary assignment that automatic generation cannot change. |
| Manager override | Explicit authorization for a specifically permitted scheduling conflict on a manual lock; not a waiver of all rules. |
| Feasible complete schedule | Every required primary block covered, every exact target met and every hard rule satisfied, including recognized manual exceptions. |
| Fairness balance | Persistent outstanding compensation arising from temporary workload differences; separate from permanent decisions. |

Duty intervals are start-inclusive and end-exclusive. The existing model stores
date boundaries; product descriptions use 09:00 handovers. Availability must be
checked on every date covered by the duty, including Saturday in a combined
weekend. Adjacency and spacing must use the actual interval, not just the first
displayed date. Calendar/time conventions for a numerical spacing metric require
review; the duty lengths and ownership themselves are not optional.

### 3.1 Canonical weekends and calendar ownership

**Friday owns the weekend, including a Saturday in the next month or year.**

For Friday 31 December 2027 and Saturday 1 January 2028:

- Combined: one December-owned block from 31 December through 2 January.
- Split: two blocks, both December-owned, sharing weekend identity 31 December.
- January generation must preserve both forms as fixed context. It must not
  generate a separate January-owned 1 January duty or count its points again.

The existing calendar omits the first Saturday's row when a month starts on
Saturday; the owning month still exposes that Saturday for editing. Other
adjacent-month dates appear as read-only context. Generation ownership must not
be inferred from which calendar cells happen to be visible.

Combining or splitting must not duplicate coverage, points or identities.
Current normalization recombines identical primary/secondary weekend halves when
no special prevents merging. A future design must also preserve lock and override
meaning; it cannot discard a lock merely by changing the weekend representation.
Whether generation may itself change the combined/split structure is not an
approved product choice in these requirements.

## 4. Points and monthly totals

### 4.1 Duty weights

| Duty | Base points | Special addition |
|---|---:|---|
| Ordinary weekday | 1 | Configured extra for that covered date, if special. |
| Combined Friday–Saturday | 1 total | Existing special handling creates separate daily weekend blocks. Do not add the combined base again. |
| Split Friday | 0.5 | Configured extra for Friday. |
| Split Saturday | 0.5 | Configured extra for Saturday. |
| Emergency/secondary coverage | 0 regular points | No primary-duty workload or fairness points. |

For a special daily block `d`:

`points(d) = base(d) + extra(d)`

The extra is per covered duty/date, not once for the entire Special Block.
A two-date special covering Friday and Saturday with +2 per date gives two
2.5-point duties, 5 points total. They still share one weekend identity.
Special Blocks may span calendar and owner-month boundaries; each resulting duty
retains its established owner.

All allowed special additions must be multiples of 0.5. Values such as 1.1 are
invalid. Targets, edits, locks, totals and solver equalities must use exact
arithmetic. A preferred conceptual representation is integer half-point units:

`units(p) = 2 × p`

One point is 2 units; half a point is 1 unit; 34.5 points is 69 units.
Conversion must validate the input denomination, not round invalid values into
valid ones. Integer units are a modeling choice, not an approved storage schema.

### 4.2 Conservation of the month's workload

Let `D(M)` be the unique primary-duty blocks owned by month `M`, including any
Friday-owned Saturday outside its calendar month. Let `p[d]` be a block's full
primary-duty point weight.

`P[M] = sum(p[d] for d in D(M))`

This includes all required duties, whether already assigned, locked or still
empty. It includes normal duties, the chosen combined/split representation,
special additions and owned cross-month weekend coverage. Exclude duties owned
by other months and exclude emergency coverage.

If `T[e]` is engineer `e`'s final target:

`sum(T[e] for all participating engineers) = P[M]`

Manually locked primary points are part of this total, not extra workload added
on top of it. For a 34.5-point month, targets must sum to exactly 34.5.
No coverage points may disappear or be invented by redistribution.

Let `L[e]` be that engineer's locked primary-duty points owned by `M`:

`R[e] = T[e] − L[e]`

`R[e]` is the exact workload still to generate. Require `T[e] >= 0` and
`R[e] >= 0`. If all locks are valid:

`sum(R[e]) = sum(p[d] for unlocked d in D(M))`

Every final target is strict. Neither a close numerical result nor a better
spacing score substitutes for equality. Half-point arithmetic alone does not
guarantee a target is attainable from the available indivisible duty weights.

### 4.3 Changed input

Special-point edits, weekend structure changes, changed locks, availability,
membership or neighboring assignments can invalidate a previous allocation or
feasibility result. Any result must correspond to the actual inputs being saved;
stale validation is not evidence that new inputs are feasible.

In particular, the system cannot use old targets whose sum differs from a changed
monthly total. How to recalculate targets, preserve manager edits, obtain review
and handle a Special Block spanning independently managed months is not yet
determined. No silent target rewrite is authorized.

## 5. Fairness baseline and seniority

Display eligible active engineers from most senior at the top to newest at the
bottom. The existing saved seniority order is the source; a manager who is an
eligible active engineer can also receive duties.

The default allocation must slightly favor newer engineers, consistent with the
existing intent. Its exact integer/half-point targets must account for:

- The selected owner's total primary-duty points.
- The number of active eligible engineers.
- Seniority.
- Outstanding temporary fairness compensation.
- Feasibility under actual duties, constraints and locks.

Do not adopt the current heuristic's 1.00–1.22 weights as a newly approved exact
allocation formula. The rounding/remainder policy, relationship between seniority
and carried compensation, and method for accommodating feasible allocations
require review. The manager must see any allocation that needs changing; the
date solver cannot make its own target adjustments.

For subsequent sections, `F[e]` means the default allocation offered for manager
review after considering the baseline and carried compensation. `F[e]` does not
define how that calculation works. Keep the ordinary fair baseline concept
distinct from compensation already applied to this month's proposed allocation.

## 6. Temporary and permanent adjustments

Let `temp[e]` and `perm[e]` denote this month's signed changes to the offered
allocation:

`T[e] = F[e] + temp[e] + perm[e]`

This identity defines the final target, not a fairness-ledger recurrence.
Redistribution must preserve the exact monthly total and retain which changes
were temporary and which were permanent, including both sides of a transfer.

| Adjustment | Manager control | Future compensation |
|---|---|---|
| Temporary | Main Target column. Used for vacation, limited availability or other temporary scheduling difficulties. | Record both reduced workload and the extra workload carried by others. Attempt compensation in following months. |
| Permanent | Permanent column, using a neutral name. Used for volunteering, deliberate extra/reduced workload, a disciplinary decision or another intentional manager decision. | Never creates debt or credit for either side of that deliberate redistribution. |

The Target column shows one clear **final target**, including permanent changes.
Editing Permanent changes that final target; its value must not be added a second
time when interpreting the table. Internal accounting may retain components,
without exposing several competing fairness counters.

### 6.1 Temporary redistribution

When reducing an engineer's temporary target, redistribute the released points
to the next eligible engineer in seniority order. If that engineer cannot accept
the points, continue through eligible engineers. If no valid redistribution
exists, explain the conflict and prevent Generate until resolved.

Eligibility means more than an available-date count. Consider locked points,
exact attainable weighted totals, shared capacity, consecutiveness, boundary
assignments and weekend limits. A change that passes individual checks but makes
the whole schedule impossible is not a valid redistribution.

The requirements do not specify whether traversal wraps after the newest member,
how transfers are split among recipients, how reverse/increasing Target edits
choose donors, or how a 1-point UI edit is handled when only half-point transfers
are globally feasible. These mechanics require review. A timeout must not be
reported as proof that a proposed recipient cannot accept points.

### 6.2 Permanent redistribution

When the manager increases one engineer's Permanent allocation, automatically
subtract the corresponding points from another eligible engineer. Apply the
agreed preference: **choose the most senior eligible engineer among those with
the highest current allocation**.

Do not subtract from an engineer if the resulting target or their locked duties
make the change impossible. Validate the resulting allocation globally and
preserve its total. If no eligible redistribution is possible, explain the
problem instead of accepting an invalid change.

Both the increase and the offsetting decrease are permanent. Neither creates
future fairness compensation. Behavior for a Permanent decrease, a transfer that
needs several donors, and the exact interpretation of allocation during donor
ranking are not fully specified; do not invent complementary rules.

### 6.3 Both types in the same month

For an illustrative offered allocation of 2 points:

`2 offered + 1 temporary + 1 permanent = 4 final points`

The manager sees final Target 4. The system retains the two distinct causes.
Counterpart transfers elsewhere must keep the month's sum unchanged. Only the
temporary differences participate in future compensation.

## 7. Compensation across months

### 7.1 Required behavior

Temporary differences create persistent fairness balances. Try to compensate in
the following month. If vacation, constraints, point combinations or other hard
rules prevent settlement, carry the unfulfilled balance forward until it can be
compensated. Balances do not expire after one month.

Account for engineers who temporarily receive fewer points and engineers who
temporarily carry additional workload. Never use unavailable, consecutive or
otherwise invalid automatic assignments to settle a balance. Permanent manager
decisions do not create compensation.

Historical information may inform the current allocation. It must not cause
generation to modify a previous or next month's assignments or rewrite a
previously published schedule.

### 7.2 Conceptual accounting model

The future model must distinguish the following concepts, even if the UI exposes
only a final Target and concise explanations:

| Concept | Required role |
|---|---|
| Ordinary baseline | What fair workload would mean for that month before intentional permanent changes and temporary departures. Its exact calculation is pending. |
| Opening temporary balance | Compensation still outstanding from earlier months. |
| Compensation applied to the offered allocation | The part of the current proposal intended to settle that opening balance, when feasible. |
| Permanent adjustments | Deliberate workload changes, including offsetting transfers, excluded from compensation. |
| Temporary adjustments | Temporary departures and the workload redistributed to others. |
| Actual published primary points | Workload from the authoritative current publication for the owner month, including approved swaps. |
| Remaining temporary balance | Unsettled compensation that must continue into later months. |

For an authoritative publication `V(M)`, the actual workload is determined:

`A[e,M] = sum(p[d] for d owned by M in V(M) where primary(d) = e)`

Exclude emergency coverage, non-current historical versions, unpublished drafts,
and duplicated carried weekend rows. Use the application's current authoritative
publication, not merely the numerically largest version or the original
pre-publication plan.

An approved swap can exchange differently weighted duties. The destination duty
keeps its own points; actual workload changes accordingly. Reconcile fairness
using those actual published points. Reopening or editing an unpublished draft
does not make that draft the authoritative fairness history.

The requirements do **not** uniquely determine a formula for closing balances.
In particular, they do not determine how to combine an ordinary baseline,
repayment already applied, current temporary changes, permanent changes and
post-publication swaps without double-counting compensation. No ledger recurrence,
sign convention, rounding rule or repayment priority is approved by this document.

Permanent intent must remain distinguishable when actual published workload
changes. Whether permanent intent follows an engineer, a duty or another reviewed
accounting reference after a swap is not yet determined. Also unresolved are
opening balances for membership changes and how later publication replacement or
deletion propagates through balances already used for subsequent allocations.
These choices must preserve the requirements above and must not rewrite schedules.

The future persistence design must retain enough information to explain and
reconcile the chosen accounting model against authoritative publications.
Re-reading the same publication or applying its update more than once must not
invent additional debt or credit. No schema is selected here.

## 8. Pre-generation allocation popup and UX

A **single allocation popup/modal is required before dates are generated**.
Keep essential allocation information, warnings, validation status and conflict
details inside that popup or its existing inline area.

### 8.1 Main table

| Column | Required presentation |
|---|---|
| Engineer | Name, most senior first and newest last. |
| Target | Main editable control, representing the clearly identified final point target, including temporary and permanent effects. |
| Permanent | Intentional signed adjustment; concise indication that it never creates future compensation. |
| Locked | Current locked primary-duty points owned by the selected month. |
| Generate | Exact remaining primary points: Final Target minus Locked. |

The final target must be visually unambiguous. Show a clear monthly total and its
required total so the manager can see whether the allocation balances.
Do not make the manager infer the final result from several counters.

Example: Target 3, Locked 1, Generate 2. If Target and Locked are both 3,
Generate is 0 for that engineer. If Locked is 4 and Target is 3, the allocation
is invalid; never display or accept a valid negative remaining workload.

### 8.2 Editing

- Use simple + and − controls.
- Default to **1 point per adjustment** whenever the popup opens.
- Offer a small toggle for **0.5-point adjustments**.
- Make temporary versus permanent effects clear through concise inline text.
- Explain automatic counterpart redistribution inline.
- Keep the popup compact, scrollable as needed, intuitive and usable on mobile.
- Preserve English LTR, Hebrew RTL, accessible control names, keyboard operation
  and appropriate modal focus behavior.

Do not introduce adjustment-explanation popups or a second conflict-details
dialog. Do not require the manager to understand optimization mathematics.
Avoid clutter from multiple fairness counters.

### 8.3 Validation presentation

Show obvious errors immediately and global validation state clearly. Disable
Generate for structural invalidity or confirmed infeasibility. The manager can
resolve conflicts by editing targets or explicitly changing/locking assignments.
Do not silently turn a positive target into zero because availability is limited.

Pending, cancelled and unknown validation must not be described as mathematical
failure. Present them inline and keep the interface responsive. Whether Generate
is disabled while checking, whether it can launch further solving after an
UNKNOWN result, and the detailed retry/cancel interaction remain decisions for
review. In every case, successful generation requires a verified complete
assignment satisfying the confirmed targets.

The governing UX principle is **simple manager experience, sophisticated
algorithm underneath**. Manager-facing explanations use names, dates, duties,
points and constraints. Solver terms such as “MILP infeasibility certificate”
must not be the primary message.

## 9. Manual locks and explicit overrides

### 9.1 Lock / Unlock

Provide manager-controlled Lock / Unlock for primary assignments. A manager may
select an engineer manually and lock that duty. Once locked:

- Generate and Regenerate preserve the primary engineer and duty.
- The duty's full primary points count toward that engineer's exact target.
- Those points reduce what the solver still has to assign.
- The lock remains until the manager explicitly unlocks or changes it.
- The assignment is clearly distinguishable from an automatic assignment.

Lock state and its meaning must survive saving and reloading a draft. Current
legacy optional fields are not evidence that this feature already exists.
No lock persistence schema or publication/restore metadata design is selected.

### 9.2 Override boundaries

| Situation | Required treatment |
|---|---|
| Locked duty on an unavailable date | An intentional manager availability override is permitted. Preserve the availability constraint; the engineer need not remove it. |
| Deliberately locked consecutive duties | May remain under an explicit manager-override model. The solver must not create the violation itself. |
| Automatic duty consecutive with another automatic duty or a fixed assignment | Forbidden. A nearby lock is not blanket permission to add a new conflicting automatic duty. |
| Locked duty conflicting with an existing adjacent-month assignment | Do not edit the adjacent month. How the explicit exception is authorized and recognized across the boundary requires review. |
| Additional weekend on a locked assignment | Only an explicitly agreed manager weekend exception may apply. Do not assume every lock overrides the weekend cap. |
| Missing/inactive identity, duplicate primary/secondary, invalid coverage or stale revision | Preserve structural, integrity and permission protections. A scheduling override is not a general bypass. |

The explicit approval and scope of a consecutive override must be clear. A
generic existing `manager_override` boolean, currently used for other exceptions,
does not by itself define the new lock policy.

### 9.3 Lock validation

Validate locked points, identity, ownership, duty representation and all remaining
capacity. A lock can make a different engineer's target impossible by consuming
their only viable duty. Global validation must account for that consequence.

Target 3 with Locked 4 disables Generate. Target 3 with Locked 3 forbids assigning
more primary points to that engineer. Intentional overrides do not exempt locks
from point accounting. An impossible remainder is still impossible even if the
locked points do not exceed the target.

## 10. Hard scheduling constraints

For a complete generated schedule, enforce all of the following simultaneously:

| ID | Hard requirement |
|---|---|
| H1 | Every required primary-duty block owned by the selected month is covered exactly once. |
| H2 | Every engineer receives exactly their final allocated primary-duty points. |
| H3 | Every automatic assignment respects unavailability on all dates covered by its interval. |
| H4 | Every locked primary assignment remains fixed. |
| H5 | The solver creates no consecutive primary duties for an engineer, including conflicts with fixed boundary assignments. |
| H6 | An engineer covers at most one distinct primary weekend owned by the month, unless an explicitly agreed manager exception applies. |
| H7 | Combined/split weekend identity, coverage and Friday ownership are preserved without duplication. |
| H8 | Interval rules use actual duty start/end ranges, including full combined-weekend lengths. |
| H9 | Assignments owned by neighboring months remain unchanged. |
| H10 | Assignment identities and active approved team eligibility are valid. |
| H11 | Authorization, checked writes, revision protection, publication integrity, private-data protections and previously agreed integrity rules are preserved. |

Manual exceptions are limited to the contexts described in section 9. They do
not allow the solver to relax constraints, repair totals by changing targets,
or remove coverage. A hard rule must not become a soft penalty.

### 10.1 Consecutive duties

The same engineer must not automatically receive either block in a consecutive
pair that the solver creates. Forbidden examples include:

- Monday daily duty followed by Tuesday daily duty.
- Thursday daily duty followed by a combined Friday–Saturday duty.
- A combined Friday–Saturday duty followed by Sunday daily duty.
- Last duty of one month followed immediately by the first duty of the next.
- Separate split-Friday and split-Saturday blocks for the same engineer.

A combined Friday–Saturday duty is one block; its internal Friday-to-Saturday
continuity is not a pair of consecutive assignments. Split halves are separate
blocks and must obey the same no-consecutive principle unless explicitly
overridden by manager locks. Special weekend dates remain separate daily blocks.
Do not silently merge an intentional split or special duty to evade the rule.

### 10.2 Weekend limit and small teams

Count distinct Friday weekend identities in the owner month. Either half consumes
the engineer's allowance for that weekend; both halves share one identity.
Emergency coverage consumes none of the regular primary allowance.

The one-weekend limit can prevent a complete schedule for a small team regardless
of weekday spacing. A two-engineer algorithm should alternate duties as far as
feasible, but must report impossibility when the weekend cap or another hard rule
prevents coverage. There is no automatic small-team exemption.

### 10.3 Neighboring months

Inspect existing previous-month assignments and next-month assignments if they
already exist. Use their actual intervals, owners and scheduling status.
Relevant published and working assignments are fixed context, not targets that
the current solver can move.

Prevent an automatic assignment next to an engineer's fixed duty immediately
before or after the selected month's owned coverage. This includes a December
weekend ending on 2 January: adjacency is tested at its actual end, not at the
calendar month's midnight boundary.

Current manager snapshot conversion uses working rows for open draft months and
the current publication for published months; a publication view uses current
publications. A reopened neighboring month can therefore have both a live
publication and a different working draft. Which source or combination must
constrain generation in that case is not fully specified. The redesign must
define that status policy before implementation, without editing either source
or treating arbitrary old versions as current assignments.

### 10.4 Emergency coverage

Preserve all existing emergency/secondary assignments on their duties through
Generate and Regenerate. Emergency assignments:

- Earn zero regular primary-duty points.
- Do not affect targets or temporary compensation.
- Do not affect spacing or consecutiveness.
- Do not count against the primary weekend limit.
- Are not allocated by the main scheduling algorithm.

The existing database requires a duty's primary and secondary to differ, and
current publication checks also validate secondary membership and availability.
These integrity/permission protections remain in force. Fully excluding
emergency duties from generation decisions conflicts with using secondary
identity to rule out a primary candidate. The approved resolution of that
conflict is not specified. Do not remove emergency coverage, weaken the identity
check, or invent a new primary-candidate policy to resolve it silently.

## 11. Spacing optimization

### 11.1 Ordered objectives

| Priority | Objective |
|---:|---|
| 1 | Establish hard feasibility: complete coverage, exact targets, fixed locks and all hard rules. |
| 2 | **Maximize the smallest gap between any two primary duties assigned to the same engineer.** |
| 3 | After maximizing that minimum, optimize overall spacing and distribute duties as evenly as reasonably possible. |
| 4 | Select a high-quality alternative arrangement where possible. |

Do not replace the minimum-gap objective with average spacing or a sum that can
hide one very close pair. Do not trade exact targets or hard rules for prettier
spacing or a different arrangement. Point fairness is primarily settled at the
allocation stage.

### 11.2 Required spacing context

Consider primary-duty intervals within the month, the final previous-month duty,
existing next-month duties, actual duty lengths and fixed locks. Emergency
assignments do not enter the objective. Small teams should achieve the maximum
spacing their feasible allocation permits, including alternating where possible.

Conceptually, for feasible schedule `S`, engineer `e` and applicable duty pairs
`Q[e,S]`, the primary objective has the form:

`maximize min(gap(a,b) for e and (a,b) in Q[e,S])`

This expresses the agreed max-min priority. It does not select the final gap
metric or solver encoding. The metric must account for actual intervals rather
than assume equal-length duties or measure only displayed start dates.

Not yet determined are the exact numerical time/calendar metric, the
secondary evenness objective, boundary horizon, and conventions when an engineer
has fewer than two applicable duties. Locked or neighboring fixed pairs can
determine the minimum regardless of automatic choices. Do not silently exclude
such pairs or redefine the primary objective to overcome that effect; the
precise treatment requires review.

Existing preferred-date input is distinct from unavailability. The current
engine rewards it softly. These requirements do not assign it a new priority
relative to max-min spacing, overall evenness or alternative selection.

## 12. Feasibility validation

Use two levels of validation in the allocation popup. Per-engineer counts are
necessary in some cases but never sufficient to prove global feasibility.

### 12.1 Immediate checks

Detect cheap contradictions as early as possible:

- Targets do not sum exactly to the month total.
- A target is invalid, uses an invalid denomination or is negative.
- Locked points exceed target or remaining workload is negative.
- A required duty has no eligible automatic candidates and no valid manual lock.
- A positive target has no feasible remaining opportunities.
- Required identities or eligibility are missing.
- Available weighted capacity is clearly below required workload.
- Available duty weights cannot sum to an exact remainder.
- Obvious weekend-cap, lock, coverage or boundary contradictions exist.

Capacity estimates must reflect duty weights and cannot assume a person can
accept all individually available dates simultaneously. A successful fast check
means “no obvious contradiction found,” not “feasible.”

### 12.2 Complete global check

Use an exact constraint solver to evaluate all engineers and required duties
together. It must model exact weighted totals, shared availability, consecutive
restrictions, weekend caps, boundary context, locks, special weights, and combined
or split weekends. A heuristic failure or an individual capacity estimate does
not prove mathematical impossibility.

Use the same confirmed inputs and hard rules for validation and generation.
A solver-produced complete valid assignment is evidence of feasibility. A claim
of infeasibility requires a conclusive result, not exhausted heuristic attempts.

### 12.3 Result states and interaction

| State | Meaning | Required handling |
|---|---|---|
| Structurally invalid | The allocation/input itself violates a directly checkable invariant. | Explain inline and disable Generate. |
| Pending | Validation has not finished for current inputs. | Show checking state; do not claim feasibility or infeasibility. Exact Generate/cancel interaction requires review. |
| FEASIBLE | At least one complete assignment satisfying all hard rules exists. | The date solver can pursue the spacing objectives. This is not proof of spacing optimality. |
| INFEASIBLE | The complete rules/targets are mathematically contradictory. | Explain grounded conflicts inline and disable Generate until inputs change. |
| UNKNOWN / TIMEOUT | Search has not established feasibility or infeasibility within its limit. | Explain that validation did not finish; do not call the allocation impossible. Retry/continue policy requires review. |
| Cancelled or stale | Search was cancelled or its inputs changed. | Do not apply its result to the current allocation. |

A feasibility witness and a proven optimum are different facts. If optimization
times out after finding a feasible incumbent, the product policy for accepting
that schedule without a proven optimal minimum gap is not yet determined.
Never present an unproved optimum as proved or a partial assignment as feasible.

### 12.4 Diagnostics

Give actionable explanations based on demonstrated facts: affected engineers,
dates, required points, shared capacity, relevant locks, boundary conflicts or
weekend restrictions. A complex infeasible model may have several interacting
causes. Do not promise a guaranteed minimal explanation or invent a single
root cause. When only part of a conflict is understood, describe that limit.

All warnings and details stay in the allocation popup's inline area. The manager
can adjust temporary targets, make intentional permanent adjustments, manually
assign and lock duties, unlock/change locks, and rerun validation.

## 13. Conflict cases and manager explanations

These cases are required diagnostic and acceptance scenarios. Suggested wording
illustrates the facts to communicate; final localized copy is not fixed here.

| Case | Required detection and outcome |
|---|---|
| A. Entire month unavailable | A positive target with no feasible duties is a pre-generation conflict. Explain the engineer and unmet target. The manager may temporarily reduce/redistribute it or explicitly assign and lock an otherwise unavailable duty. A legitimate zero target can be valid if the whole allocation remains feasible. |
| B. Nobody available for a duty | Identify the uncovered primary duty and its dates. Never automatically violate availability. The manager may deliberately lock somebody. Do not report a completed valid schedule while the duty is empty. |
| C. Limited but sufficient opportunities | Two newer engineers may each have only three feasible one-point opportunities and need three points each. Limited availability alone is not an error if the global model is feasible. The solver must account for scarce opportunities when finding a complete solution, rather than consume them casually and fail later. All other hard rules still apply. |
| D. Shared capacity shortage | Detect groups that individually look feasible but compete for insufficient shared duty capacity. Explain the engineers, combined need and demonstrated shared capacity. |
| E. Consecutive-only opportunities | Available-date counts may be enough while no nonconsecutive combination exists, including conflicts with neighboring assignments. Detect this restriction. |
| F. Weekend limit | Enough available dates/points can still require too many distinct weekends. Detect and explain the cap conflict instead of relaxing it. |
| G. Weight incompatible with target | A three-point target with only a four-point duty available is impossible. Do not assign four points or split a duty's weight arbitrarily. |
| H. Locked conflicts | Check locked points above target, incompatible locks, scarce duties consumed for others, boundary conflicts and the exact remaining achievable workload. Recognized intentional exceptions apply only in the authorized contexts. |

### 13.1 Shared-availability example

Daniel and Noa each need 3 points. Each is available only on 5, 12 and 19 November.
Assume those are the same three ordinary one-point primary-duty slots and neither
has other usable coverage or locks.

`combined required points = 3 + 3 = 6`

`shared available primary-duty capacity = 1 + 1 + 1 = 3`

Each passes a naive individual three-date count. Together they cannot receive
6 points from 3 points of coverage.

An understandable explanation is:

> Daniel and Noa need 6 points together, but their available dates contain only
> 3 points of duty capacity.

The manager can adjust temporary targets and redistribute the difference, or
manually lock additional duties after consulting the affected engineers.
Use this exact capacity explanation only when the model supports it. If weights,
consecutiveness, caps or several overlapping groups are the actual restriction,
explain those facts instead of claiming this simple arithmetic is a complete cause.

### 13.2 Full failure versus an unfinished draft

The current engine may save uncovered duties for manual resolution. The future
success contract requires a full feasible schedule. An individual duty may still
be visibly unassigned while the manager resolves an unfinished draft; that view
must not imply successful generation.

Whether an unsuccessful future search may save a newly computed partial draft,
and how that differs from retaining the existing working draft, is not determined.
Neither behavior may discard locks, alter emergency assignments or neighboring
months, or be presented as a successful complete result.

## 14. Mathematical model and solver architecture

This section describes a **conceptual engineering direction**. Product rules in
earlier sections are authoritative; the specific formulation, integration package
and execution architecture must be evaluated before implementation.

### 14.1 Preferred direction and technology assessment

Use a real constraint-based approach instead of relying on approximately
90 heuristic attempts to find feasibility. MILP is the discussed direction;
the open-source HiGHS solver is a leading candidate. JavaScript/TypeScript
integration, WebAssembly where suitable and a Web Worker are preferred avenues
for assessment to keep the interface responsive.

This is not approval to install an unverified HiGHS wrapper or any other package.
Before selection, assess actual TypeScript and Next.js App Router compatibility,
browser support, maintenance, license, deployment/bundling constraints,
WebAssembly loading and iPhone Safari behavior/performance. No claim of validated
compatibility or performance is made here.

No new backend service, paid API or AI inference should be required. Such a
dependency would need a demonstrated technical need and manager approval.
Keep scheduling mathematics independent of React, browser UI and storage.

### 14.2 Inputs and exact units

A model instance needs:

- Canonical selected-month duty IDs, actual intervals, point weights and owners.
- Combined/split structure, shared weekend IDs and special-date additions.
- Active eligible primary engineers and seniority order for allocation context.
- The manager-confirmed exact final targets.
- Availability for all covered dates.
- Locked primary assignments and the precise explicitly permitted exceptions.
- Fixed relevant neighboring assignments and their authoritative status.
- Emergency assignments as preserved data, with the unresolved identity
  interaction addressed before claiming the final model is complete.
- The source revision and reproducibility settings for the problem being solved.

Use an exact unit domain such as `q[d] = 2 × p[d]` and `t[e] = 2 × T[e]`.
Duties are indivisible assignment blocks; integer half-point units do not
authorize splitting a block among engineers.

### 14.3 Binary assignment model

For an allowed engineer/duty combination:

`x[e,d] ∈ {0,1}`

One means engineer `e` receives primary duty `d`. Automatic combinations must
satisfy availability and eligibility. An explicitly authorized locked
availability override is fixed input and cannot be filtered out merely because
the automatic combination would be forbidden.

Core constraints include:

| Requirement | Conceptual constraint |
|---|---|
| Complete primary coverage | For each owned duty `d`, `sum(x[e,d] over engineers) = 1`. |
| Exact target | For each engineer `e`, `sum(q[d] × x[e,d] over D(M)) = t[e]`. |
| Fixed lock | For a valid lock assigning `d` to `e`, `x[e,d] = 1`. |
| Unavailable/invalid automatic pair | Exclude that automatic pair or fix its variable to zero. |
| Non-overridden consecutive pair | For engineer `e` and conflicting duties `a,b`, `x[e,a] + x[e,b] <= 1`. |
| Fixed boundary conflict | Treat the neighboring assignment as a constant and prohibit the conflicting automatic selected-month variable. |
| Weekend cap | Model whether an engineer uses each distinct Friday weekend identity; at most one, absent an explicitly approved exception. |
| Month isolation | Out-of-owner assignments are fixed context, never free decision variables or part of current-month targets. |

An alternative equivalent formulation can remove locked duties from free
variables and require the unlocked weighted sum to equal `2 × R[e]`. Never
count locked points both in the target equality and again as additional workload.

Weekend indicators must represent distinct weekend identities, not a simple
count of Friday/Saturday rows. An approved locked conflict must be represented
explicitly; blanket adjacency constraints would wrongly reject it, while blanket
removal of adjacency restrictions would permit new automatic violations.
Cross-month and weekend override scope still needs the decisions identified above.

This table is not a complete approved MILP. The full model must also preserve
identity/integrity requirements, actual interval coverage and the unresolved
policies without filling them in implicitly.

### 14.4 Feasibility, optimization and alternatives

First establish a complete feasible assignment. Then optimize minimum spacing,
then overall spacing, then alternative arrangement quality in the agreed order.
Multi-stage/lexicographic optimization is an appropriate direction to assess.
Do not mix exact targets or hard constraints into arbitrary weighted penalties
that allow them to be traded away.

Distinguish feasibility status, spacing optimality and alternative diversity.
Reproducibility may require recording the exact input problem, solver version,
settings and any seed or deterministic tie-break configuration. A seed alone
does not establish identical results across different solver versions or inputs.

Solver output must be checked against the exact duty/target invariants before
it becomes a saved successful result. Numerical solver tolerances must not
permit a wrong half-point total or invalid assignment through the product boundary.
This is a verification requirement, not permission to round targets or silently
repair invalid solver output.

### 14.5 Performance, cancellation and time limits

Benchmark the typical 12-engineer month and harder models:

- Very constrained and heavily shared availability.
- Many split or special weekends.
- Difficult special-weight combinations and half-point targets.
- Small and large teams.
- Multiple locks and authorized overrides.
- Existing previous/next-month assignments.

Measure model construction, global feasibility, spacing stages, repeated
allocation edits and alternative generation. Validate memory use and browser
responsiveness, including iPhone Safari; do not invent benchmark thresholds.
Define acceptable performance and search limits from that assessment.

Support cancellation and clear pending/timeout feedback without freezing the UI.
An input change or cancellation must not let an obsolete result overwrite newer
work or validate a different allocation. Whether global validation can complete
quickly enough for each intended interaction is an engineering risk to measure,
not an assumption that UNKNOWN means impossible.

### 14.6 Persistence and security boundaries

Preserve the existing separation between working drafts and current publications.
NULL-publication assignment rows currently represent open drafts; publication
creates immutable version rows and removes that month's working rows. Reopen or
historical restore copies only the owner's duties into a draft. Cancel Draft
deletes that owner's working rows without changing the current publication or
history. Generation must respect those lifecycle operations.

Continue checked, authorized, revision-protected writes. An old solver result
must not bypass a changed workspace revision. Preserve active/approved member
checks, primary/secondary identity restrictions, foreign keys, interval integrity,
private availability notes, consent/admin approval and publication history.
UI controls or client solver claims do not replace database authorization.

Future schema/RPC work for targets, adjustment provenance, locks or balances is
outside this document's implementation scope and must follow
[Supabase setup](SUPABASE_SETUP.md) and the existing database review workflow.
Future release work follows [deployment rules](DEPLOYMENT.md), including
database-first ordering and required approval. No permission weakening or hosted
change is authorized by the solver direction.

## 15. Generate and Regenerate lifecycle

### 15.1 Generate

| Step | Required behavior |
|---:|---|
| 1 | Read the selected month's canonical owned duties and current scheduling data, including locks, emergency coverage, relevant neighboring assignments and revision. |
| 2 | Calculate the exact total primary-duty points, with special additions and Friday-owned cross-month weekends. |
| 3 | Calculate the fair baseline/default allocation and consider carried temporary balances using the reviewed accounting policy. |
| 4 | Open the single allocation popup with seniority ordering, final targets, permanent changes, locked points and remaining points. Reset edit step to 1. |
| 5 | Let the manager make temporary and permanent adjustments with + / − controls and the optional 0.5 step. |
| 6 | Apply the agreed redistribution rules and immediate validation while maintaining the exact monthly total. |
| 7 | Account for all manually locked primaries in the confirmed targets and remaining workload; retain their explicit override meaning. |
| 8 | Verify complete global feasibility for the current inputs. Distinguish invalidity, infeasibility and unknown/pending outcomes. |
| 9 | Solve the date assignment using the agreed spacing hierarchy. Never revise targets inside this stage. |
| 10 | Save the verified result as a draft through the authorized revision-protected path, preserving locks, emergency assignments, adjacent months and publication history. |
| 11 | Present the generated schedule for manager review. Generation does not publish it. |

Locks must already be visible when the popup opens; step 7 reasserts their effect
on the final confirmed allocation, rather than discovering them only afterward.
No solver result can be treated as current if its allocation, duty structure or
source revision has changed.

### 15.2 Regenerate

Regenerate uses the same exact targets and hard rules and seeks another
high-quality arrangement where possible. It must preserve:

- Every locked primary assignment and its explicit exception meaning.
- Existing emergency coverage on its duties.
- Exact primary targets and month totals.
- Availability, consecutive-duty and weekend rules for automatic assignments.
- Fixed context and assignments owned by other months.
- Current publications, historical versions and unrelated draft data.

Avoid an identical arrangement when meaningful alternatives exist, if practical
without sacrificing the agreed quality hierarchy. Never promise a different
schedule when the feasible arrangement is unique. Do not introduce invalid
assignments or silently accept worse higher-priority objectives for variety.
The definition of meaningful difference and detailed alternative-selection
mechanism remain engineering/product choices for review.

Use reproducible settings/seeds where appropriate while supporting alternative
valid schedules. Regeneration is not permission to reset the manager's allocation
to a newly computed default. Treatment of existing automatic assignments and
manually edited **unlocked** draft primaries, including any preference to retain
them, is not fully specified. Only explicit locks have the required preservation
guarantee.

### 15.3 Manual resolution

When a full valid schedule cannot be established, show what is known and which
manager interventions could address it. The manager can:

- Change temporary targets and redistribute workload.
- Apply deliberate permanent adjustments.
- Manually assign and lock duties, including authorized availability overrides.
- Unlock or change previous locks.
- Rerun feasibility validation.

No failure path may quietly remove locks, exceed targets or violate constraints.
Unknown search status requires an honest status explanation, not a fabricated
conflict. Unfinished-draft persistence and pending/unknown interactions require
the explicit decisions recorded in sections 12 and 13.

## 16. Worked examples

These examples illustrate required accounting and outcomes. Offered allocations
are hypothetical, not a new seniority or compensation formula. Redistribution
examples assume the stated recipient/donor change is globally feasible.

### 16.1 Exact monthly total and locked remainder

A month contains 34.5 primary-duty points, or 69 half-point units. One possible
target sum for 12 engineers is:

`3 engineers × 2.5 + 9 engineers × 3 = 34.5 points`

This is an arithmetic example, not the prescribed default distribution.
All 69 units must be assigned once to primaries. Emergency coverage adds none.
For an engineer with Target 3 and one locked ordinary duty:

| Final Target | Locked | Remaining Generate |
|---:|---:|---:|
| 3 | 1 | 2 |
| 3 | 3 | 0 |
| 3 | 4 | Invalid; Generate disabled. |

### 16.2 Temporary reduction and carry-forward

Engineer A's offered target is 3, but vacation leaves only 2 feasible points.
The manager temporarily reduces the target to 2. The released point is
redistributed through the agreed seniority-order process to an eligible engineer.
The month's total stays unchanged.

Retain both A's temporary shortfall and the other engineer's extra workload for
future compensation. Try to compensate in the following month. If A remains on
vacation for two more months, do not erase the unresolved balance or force an
invalid assignment. The exact amount applied in each later month depends on the
accounting and allocation policies still to be reviewed.

### 16.3 Permanent redistribution preference

Assume this current allocation and seniority order:

| Seniority | Engineer | Current final allocation |
|---:|---|---:|
| 1, most senior | A | 4 |
| 2 | B | 4 |
| 3 | C | 3 |
| 4, newest | D | 3 |

Increasing D's Permanent by 1 requires an offsetting Permanent reduction.
If A and B are both eligible donors, choose A: the highest allocation is 4 and A
is the most senior among that group. The new targets are A 3, B 4, C 3, D 4,
still 14 points. Neither side of this permanent transfer creates compensation.

If A already has 4 locked points, A cannot be reduced to 3. Consider another
eligible donor under the agreed preference; if none can make the transfer
feasible, explain the conflict instead of changing totals or locks.

### 16.4 Temporary and permanent changes together

An engineer offered 2 receives Temporary +1 and Permanent +1, giving final Target
4. If 1 point is locked, Generate must supply exactly 3 more.
Retain both adjustment types internally. Other engineers' corresponding changes
must preserve the month's total. The permanent point never becomes a temporary
fairness balance merely because the final Target combines both effects.

### 16.5 Cross-year weekend

For 31 December 2027–1 January 2028:

| Representation | December-owned primary points | January-owned points from this weekend |
|---|---:|---:|
| Combined, no special | 1 | 0 |
| Split, no special | 0.5 + 0.5 | 0 |
| Separate special days, +2 each | 2.5 + 2.5 | 0 |

January must preserve the existing weekend and use its actual end on Sunday
2 January as boundary context. The solver must not give that same engineer an
automatic consecutive Sunday duty merely because the weekend is December-owned.

### 16.6 Unattainable weights and exhausted locks

An engineer needs 3 points and their only candidate block weighs 4. Even with
ample chronological spacing, no exact three-point assignment exists.

Similarly, Target 3 with Locked 2.5 leaves 0.5. If every feasible unlocked block
for that engineer weighs 1 or more, nonnegative remaining points alone do not
establish feasibility. The manager must change the situation; the solver cannot
invent a half-duty or silently assign a full point.

### 16.7 Minimum spacing versus a widely spread last duty

Assume an engineer needs three ordinary one-day duties and both alternatives
below satisfy all hard rules, with no binding fixed boundary gap:

| Alternative | November duty dates | Free days between successive duty intervals |
|---|---|---|
| A | 1, 8, 29 | 6 and 20 |
| B | 1, 15, 29 | 13 and 13 |

Under this illustrative end-to-start free-day metric, B has the larger smallest
gap. A distant third duty does not compensate for the close first pair in A.
This example demonstrates the required objective priority; it does not approve
the final numerical gap metric or secondary objective.

### 16.8 Published swap changes actual points

Before an approved swap, A has an ordinary 1-point duty and B has a special
4-point duty. After approval, A holds the 4-point duty and B holds the 1-point
duty. The duty dates and weights remain attached to their slots, emergency
coverage stays on its slots, and the new current publication is authoritative.

Fairness history must reflect those actual points rather than the original
allocation. How to classify the resulting difference when permanent adjustments
also exist is a pending accounting decision, not permission to ignore the swap
or automatically reinterpret permanent intent.

## 17. Edge cases and expected outcomes

| Situation | Expected outcome |
|---|---|
| No active eligible team and positive required coverage | Cannot produce a complete schedule; explain missing eligibility. Do not allocate to inactive or unapproved identities. |
| Engineer has a legitimate zero target | No additional primary assignments. Valid only if locks and the global model allow it. |
| Target equals locked points | No additional primary points for that engineer. |
| Positive target, whole month unavailable | Pre-generation conflict unless authorized locks or an adjusted allocation resolve it. |
| Everyone unavailable for a duty | Identify the duty for manager resolution; no automatic availability violation. |
| Few opportunities, but globally sufficient | Feasible; do not reject merely for scarce availability. |
| Shared opportunities below combined demand | Confirmed global conflict when proven; explain demonstrated capacity. |
| Sufficient dates but forbidden consecutive combinations | Infeasible unless the manager changes allocation/locks under the approved override model. |
| Thursday / combined weekend / Sunday | No automatic adjacent pair for the same engineer; a combined weekend remains one block. |
| Split Friday and Saturday | Separate blocks obey no-consecutive rules and share a weekend identity/cap. |
| Two-engineer team | Seek the best feasible alternation; report any conflict with the retained weekend cap or other hard rules. |
| Different Special Block weights | Meet exact totals using whole blocks; reject unreachable target combinations. |
| Friday–Saturday crosses month or year | Friday owns both halves, including points, locks and weekend count. |
| Month begins Saturday | That Saturday remains prior-Friday-owned, despite its actual calendar date. |
| Leap day or varying month lengths | Exactly one coverage of each owned date; monthly total derives from canonical duties rather than assumed month length. |
| Locked availability/consecutive exception | Preserve the deliberate recognized exception; never infer permission for extra automatic violations. |
| Locked duty consumes another person's only opportunity | Validate all remaining targets together; show the resulting global conflict when established. |
| Selected lock conflicts with a neighboring assignment | Keep neighboring assignments fixed; explicit exception scope must be reviewed. |
| Neighbor has both current publication and reopened draft | Apply the reviewed status/source policy; no policy is silently selected here. |
| Existing emergency coverage | Preserve it and exclude it from primary optimization; preserve integrity checks pending reconciliation of the identity conflict. |
| Special points/structure change after allocation | Old totals or feasibility may be invalid. Recalculation/review interaction is still to be specified. |
| Unlocked manually edited primary in a draft | Preservation/replacement policy requires review; do not portray it as a lock. |
| Approved swap changes weighted workload | Use current published primary points in fairness reconciliation; preserve permanent provenance. |
| Balance cannot settle next month | Carry it forward without expiry or invalid assignments. |
| Search times out or is cancelled | No false infeasibility or successful partial result; apply the reviewed pending/retry policy. |
| Unique feasible or uniquely best arrangement | Regenerate cannot promise a different equal-quality schedule. |
| Stale source revision | Preserve existing checked-write rejection and refresh/revalidation behavior; no stale overwrite. |

## 18. Future implementation and test acceptance criteria

The following matrix defines **future** regression requirements. No
implementation, test code, migration, dependency or configuration change is
part of creating this specification.

Existing tests that encode intentionally changed behavior must be revised during
implementation with replacement protection for the new rules. Preserve unrelated
coverage and existing calendar, authorization, revision and history invariants.
Do not weaken a regression merely to make the new solver pass.

### 18.1 Mathematical solver tests

| ID | Scenario | Required assertion |
|---|---|---|
| M1 | Normal feasible weighted month | Every required primary block covered once; all exact targets satisfied. |
| M2 | Integer and half-point targets | Exact unit conservation; no floating-point tolerance accepts an incorrect target. |
| M3 | Special duty larger than target / incompatible subset weights | Proven impossible model is rejected, even if raw available points exceed demand. |
| M4 | Two engineers share three one-point slots but need six points | Detect global infeasibility despite individually sufficient counts. |
| M5 | Feasible but very constrained engineers | Find a complete solution without consuming scarce opportunities incorrectly or rejecting limited availability by count alone. |
| M6 | Consecutive-only opportunities, including Thursday → combined weekend → Sunday | Automatic assignments never create a consecutive pair. |
| M7 | Previous and existing next-month boundaries | Fixed intervals constrain automatic decisions; Friday-owned carried coverage is modeled once. |
| M8 | Weekend caps, small teams and many split weekends | Count distinct primary weekend identities and prove/report capacity contradictions without relaxing caps. |
| M9 | Multiple locks and authorized exceptions | Preserve fixed assignments; forbid new automatic violations; account exactly for remaining points. |
| M10 | Small instances with independently enumerable spacing outcomes | Verify the maximum minimum gap, then secondary spacing under the approved metric and objective. |
| M11 | No feasible schedule, timeout/unknown and feasible incumbent without optimality proof | Distinct statuses; no false infeasibility, false optimum or incomplete success. |
| M12 | Deterministic reproducibility, alternatives and unique arrangements | Same recorded inputs/settings reproduce as specified; valid variety respects higher priorities; uniqueness is handled honestly. |

### 18.2 Business-rule tests

| ID | Scenario | Required assertion |
|---|---|---|
| B1 | Normal fair month and seniority ordering | Reviewed default-allocation rule, active participation, exact sum and senior-first display. |
| B2 | Combined/split weekends | 1 total or 0.5 per half before additions; correct identity and primary-only cap. |
| B3 | Friday/Saturday crosses month or year; month starts Saturday; leap day | Correct ownership, coverage and monthly point totals without duplication. |
| B4 | Special Blocks, including cross-month ranges | Daily additions in 0.5 increments, correct weekend split/ownership, exact accounting and reviewed edit behavior. |
| B5 | Manual locks, unlocks, locked availability and consecutive overrides | Locks persist; availability stays recorded; only explicitly permitted exceptions survive. |
| B6 | Locked points below/equal/above target | Exact remaining workload; none added at equality; invalidity above target. |
| B7 | Entirely unavailable engineer, uncovered duty and legitimate zero target | Early actionable conflict or valid zero allocation; no silent target change. |
| B8 | Temporary redistribution | Reviewed seniority traversal, eligibility skips, exact half-point transfers and global feasibility; failure remains actionable. |
| B9 | Permanent redistribution | Most senior eligible donor among those with highest current allocation; locked floor respected; total conserved. |
| B10 | Emergency assignments | Preserved; zero regular points, no debt/spacing/consecutive/weekend effect; integrity policy also respected. |
| B11 | Changed specials, locks, membership, constraints or boundaries after allocation | Old validation is not reused for changed inputs; no silent target repair. |
| B12 | Generated/manual but unlocked draft primaries | Behavior matches the policy approved before implementation, with explicit locks always preserved. |

### 18.3 Fairness-accounting tests

| ID | Scenario | Required assertion |
|---|---|---|
| F1 | Temporary reduction and extra workload taken by recipients | Both sides reflected under the approved accounting formula. |
| F2 | Permanent extra/reduced allocation | Neither side creates future compensation from the deliberate transfer. |
| F3 | Temporary and permanent adjustments together | One correct final target; provenance remains separate. |
| F4 | Vacation or infeasible repayment across several months | Unsettled balance persists until compensated; no expiry or hard-rule violation. |
| F5 | Compensation competes with seniority and half-point remainder | Behavior follows reviewed priority/rounding policy and conserves the monthly total. |
| F6 | Approved swaps of differently weighted published duties | Actual current publication drives workload; permanent adjustments are treated under the reviewed provenance policy. |
| F7 | Repeated reconciliation, republish, restore, deletion and late historical updates | No double-counted balances; current authoritative history and reviewed propagation policy are applied. |
| F8 | New/inactive/reactivated engineers | Opening/carrying balance behavior follows the reviewed membership policy; no invented historical workload. |
| F9 | Draft generation, reopening and month independence | Unpublished plans do not replace actual fairness history; previous/next assignments are not rewritten. |

### 18.4 Database integrity and security tests

| ID | Scenario | Required assertion |
|---|---|---|
| D1 | Authorized/unauthorized generation save and lock/allocation updates | Checked manager permissions, active/approved membership and database-enforced access remain effective. |
| D2 | Concurrent save or identity/permission change while solving | Stale revisions/authorization fail atomically; no obsolete result is applied. |
| D3 | Lock and adjustment metadata save/reload and publication lifecycle | Future reviewed persistence retains the intended meaning without rewriting immutable history. |
| D4 | Primary/secondary identities, foreign keys and duty intervals | Integrity rules remain enforced; manual overrides cannot waive structural identity or span checks. |
| D5 | Exact weights and point provenance | Valid denominations round-trip; points stay with duties; no duplicate/missing owned coverage. |
| D6 | Draft/publication saves, rollback and cross-month isolation | Neighboring drafts/publications, unrelated data and history remain intact; failure causes no partial unauthorized write. |
| D7 | Availability and private notes | Access restrictions preserved; diagnostic/solver persistence does not expose private notes to unauthorized users. |
| D8 | Published swaps and current publication changes | Consent/admin checks preserved; emergency/date weights and drafts remain intact; fairness reads the authoritative result. |

### 18.5 UI interaction tests

| ID | Scenario | Required assertion |
|---|---|---|
| U1 | Desktop/mobile, English LTR and Hebrew RTL | One usable allocation popup, senior-first names and required columns; keyboard/focus access preserved. |
| U2 | Target/Permanent + / − controls | Default 1 on each opening; 0.5 toggle works; final target and counterpart changes are clear. |
| U3 | Target/Locked/Generate values | Remaining equals final target minus locked points; monthly totals and invalidity are visible. |
| U4 | Invalid/confirmed infeasible allocation | Generate disabled; concise actionable inline explanations; no second conflict popup. |
| U5 | Pending, timeout/unknown, cancellation and stale validation | Honest state under the reviewed interaction policy; no false impossibility or outdated enabling. |
| U6 | Manual Lock/Unlock and overrides | Deliberate manager intent and automatic assignments are distinguishable; no engineer constraint removal required. |
| U7 | Generate/Regenerate/manual resolution | Exact targets and locks preserved, alternatives described honestly, and incomplete coverage never presented as completed success. |
| U8 | Temporary/permanent explanation | One clear final target; future-compensation distinction understandable without multiple fairness counters or solver jargon. |

### 18.6 Integration and performance tests

| ID | Scenario | Required assertion |
|---|---|---|
| I1 | Typical 12-engineer month | Measured practical interactive performance; complete end-to-end draft flow. |
| I2 | Very constrained, small/large teams, split weekends, high special weights and many locks | Record feasibility/optimization behavior, memory and time limits without invented benchmark guarantees. |
| I3 | Repeated allocation edits and long solving | Responsive UI, cancellation and correct result/input association; no stale save. |
| I4 | Next.js deployment, browser/WebAssembly/Worker support and iPhone Safari | Actual selected integration and device behavior validated before acceptance; emulation alone is not proof of real-device performance. |
| I5 | Previous/next published and working assignments, including reopened drafts | Approved context-source policy applied without modifying neighboring months. |
| I6 | Swap, publication or availability/revision update while solving | Revalidation or checked-write rejection preserves correctness; fairness and targets reflect authoritative inputs. |
| I7 | Combined/split normalization, locks and emergency coverage through save/reload | No lost lock/override meaning, emergency change, duplicated duty or point drift. |
| I8 | Cross-owner Special Blocks and post-allocation weight changes | Reviewed workflow preserves each month's ownership, locked assignments and publication history. |

### 18.7 Acceptance gates

Before replacing the current algorithm:

1. Resolve product choices required to construct a complete, unambiguous model.
2. Approve the baseline, compensation and redistribution accounting policies.
3. Validate the selected solver/package and execution architecture against the
   actual TypeScript/Next.js/browser/device environment.
4. Demonstrate exact point conservation, complete coverage and hard constraints
   with the relevant matrix above.
5. Demonstrate persistence, security, publication and adjacent-month preservation.
6. Establish and validate measured performance, cancellation and timeout policies.
7. Keep manager-facing controls and explanations simple in English and Hebrew.

Successful local solver tests do not establish database authorization or actual
iPhone performance. Future database work and releases retain their existing
review and approval gates.

### 18.8 Unresolved decision register

This register records missing decisions, not recommended answers or permission
to weaken an agreed requirement.

| Ref | Decision still needed | Relevant sections |
|---|---|---|
| R1 | Exact baseline/seniority allocation, half-point remainder and priority of historical compensation. | 5, 7 |
| R2 | Full fairness recurrence, sign/repayment conventions, permanent intent after weighted swaps, membership and retroactive publication changes. | 7 |
| R3 | Temporary traversal/wrap, recipient splitting and reverse edits; reverse/multi-donor permanent edits; fractional redistribution. | 6 |
| R4 | Precise lock exception authorization, additional-weekend scope, adjacent-month lock conflicts and lock meaning through normalization/publication/restore. | 3, 9, 10, 14 |
| R5 | Emergency exclusion from generation versus existing primary/secondary identity and publication integrity rules. | 10, 14 |
| R6 | Neighboring source/status policy when working assignments and a current publication coexist. | 10 |
| R7 | Exact spacing metric, fixed-pair treatment, boundary horizon, secondary objective and role of preferred dates. | 11 |
| R8 | Cross-owner Special Block editing, target recalculation after point/structure changes and preservation of manager edits/locks. | 4, 14, 17 |
| R9 | Regeneration treatment of unlocked manual/automatic assignments and permitted meaningful alternative selection. | 15 |
| R10 | Pending/UNKNOWN Generate behavior, search limits, retry/cancel interaction and acceptance of feasible but unproved-optimal incumbents. | 8, 12, 14 |
| R11 | Failed-generation persistence and distinction between an existing unfinished draft and a newly produced partial result. | 13, 15 |
| R12 | Whether generation may change weekend combined/split structure; any desired small-team weekend exception requires separate agreement. | 3, 10 |
