# Monthly Generation and Compensation Specification

## 1. Purpose, authority and scope

This is the product and engineering contract for the Duty Scheduler generation
redesign. The isolated TypeScript engine in `lib/scheduling` implements canonical
duties, confirmed-target generation, independent validation and solver execution.
See [engine API, tests and benchmarks](GENERATION_ENGINE.md), the isolated
[compensation core API and tests](COMPENSATION_CORE.md), and the pure
[allocation planner API and tests](ALLOCATION_PLANNER.md). Application Generate
now opens the allocation popup, confirms targets through the checked database
boundary and executes the scheduling engine in a cancellable Worker. The spikes
in section 14.5 remain diagnostic entry points.

The pure allocation-to-publication binder validates actual draft assignments and
previews exclusive real duty capacity through the compensation core. Routed
temporary/permanent intent retains original counterpart relationships even when
an intermediary does no final work. The [database integration](ALLOCATION_DATABASE.md)
adds authoritative context, reviewed allocation persistence, checked generation
saves and SQL accounting parity. The application UI activates that boundary
without changing its database contracts.

**The manager determines exactly how many points each engineer receives.
Generate determines which primary duties to assign against those numbers.**

Compensation affects the proposed allocation before confirmation. Once confirmed,
targets are immutable solver inputs. Generate never changes targets, redistributes
workload, removes locks, relaxes automatic constraints or rewrites another month.

The system supports the typical team of approximately 12 engineers, smaller and
larger teams, and two-engineer teams. Support includes producing a verified,
clearly labeled partial draft when full coverage is impossible. A small team
does not receive an automatic exemption from weekend or consecutive-duty rules.

### 1.1 Requirements and engineering decisions

- Product requirements in this document include exact target ceilings, explicit
  locks, pairwise compensation, fresh generation before owner-month coverage
  starts and best-effort partial output.
- Recommended engineering design selects exact integer units, a pure core,
  deterministic normalization, an append-only ledger and lexicographic solving.
  Package adoption and migrations require the future implementation review.
- Current-behavior statements describe inspected source, not hosted verification.
- All blocking product decisions are resolved. Section 18.8 records V1 scope and
  readiness; routine technical decisions are specified in the relevant section.

This document supersedes the earlier complete-only design in PR #30. Within the
V1 generation window, confirmed infeasibility does **not** disable Generate.
Structural invalidity or owner-month coverage having started does.
An incomplete result is useful output, labeled **Partial / Requires Manager
Resolution**, with all uncovered dates and unmet points retained.

The architecture-review PR changed only this specification. It did not implement
the solver, UI, ledger, schema, tests, dependencies, configuration, deployments or
notifications.
Keep the pure scheduling/accounting core separate from React, browser execution,
Supabase adapters and database authorization.

### 1.2 Inspected sources

Source baseline: `develop` commit
`b29b4dcb157cb678429ff091d7f6f5c84e84f1d7`, reviewed on 23 October 2026.
The existing PR branch was inspected before editing.

| Area | Evidence |
|---|---|
| Duty blocks, points, weekends, generation and swaps | [Engine](../lib/rota/engine.ts): `blocks`, `ownerMonth`, `generate`, `totals`, `weekendCounts`, `swapDraft`; [engine regressions](../tests/engine.test.mjs). |
| Calendar and month isolation | [Dates](../lib/rota/calendar-dates.ts), [workspace projections](../lib/rota/workspace-data.ts), [workspace tests](../tests/workspace-data.test.mjs), [calendar tests](../tests/calendar-layout.test.mjs). |
| Draft generation and editors | [Draft workflow](../hooks/use-workspace-draft.ts), [duty editor](../components/rota/duty-editor.tsx), [dialogs](../components/rota/workspace-dialogs.tsx). |
| Snapshot/version selection | [Snapshot conversion](../lib/supabase/snapshot.ts), [snapshot tests](../tests/snapshot.test.mjs). |
| Integrity, publication and revision writes | [Assignment schema](../supabase/schemas/tables/duty_assignments.sql), [save/publication implementation](../supabase/schemas/functions/duty_private/save_schedule.sql), [revision check](../supabase/schemas/functions/duty_private/check_revision.sql). |
| Published commitment changes | [Swap validation](../supabase/schemas/functions/duty_private/validate_swap.sql), [swap approval](../supabase/schemas/functions/duty_private/resolve_swap.sql), [swap tests](../tests/swaps.test.mjs), [SQL swap regressions](../supabase/tests/swaps.sql). |
| Existing lifecycle and runtime contract | [Scheduling rules](../README.md#scheduling-rules-and-defaults), [Supabase setup](SUPABASE_SETUP.md), [package commands](../package.json). |

## 2. Current behavior versus the redesign

| Concern | Current source behavior | Required redesign |
|---|---|---|
| Search | 90 seeded heuristic attempts with weighted penalties/rewards. | Globally constrained optimization with explicit objective priorities and honest proof status. |
| Allocation | Points balanced during date assignment; no manager target table. | Confirmed point table precedes date generation; immutable target ceilings. |
| Incomplete coverage | Unassigned duties and warnings are possible, but without the new target/partial-result model. | Best possible valid partial draft; uncovered dates, per-engineer shortfalls and optimization status. |
| Seniority | Soft multipliers from 1.00 to 1.22 plus remainder preferences. | Approximately equal ordinary allocations; seniority only breaks equivalent choices in favor of newer engineers. |
| History/compensation | Month-independent balance; no persistent compensation ledger. | Auditable linked obligations, normalization, oldest feasible repayment and projected opening balances. |
| Consecutive duties | Allowed; short gaps penalized softly. | Automatic consecutive duties forbidden, including boundary conflicts and separate split halves. |
| Locks | Legacy optional `locked` type remains; generation ignores it and payloads do not persist locks. | Explicit persistent manager locks with specific approved exception scope. |
| Regeneration | Replaces selected-month primaries, including manual assignments. | Before owner-month coverage starts, fresh arrangement each time; only explicit locks preserve particular primaries. Confirmed targets and other persistent inputs survive. Generate/Regenerate disabled once coverage starts; manual changes/swaps remain available. |
| Randomness | Fresh cryptographic seed in the UI; deterministic engine seeds available. | Fresh seed on every Generate; equivalent input/version/settings/seed reproducibility. Seed acts only after higher objectives. |
| Emergency cover | Preserved, but currently earns full points and affects load, gaps and weekend counts. | Preserved; zero primary workload/compensation/spacing/weekend effect. Primary/secondary identity integrity still filters candidates. |
| Weekend ownership | Friday owns both halves, even across month/year. | Preserve this canonical rule and explicit combined/split structure. |
| Specials | Daily additions; weekends touched by specials split. Engine supports cross-month ranges; current UI restricts creation to selected owned duties, 1–14 days and 0–20 extra points. Adding a range clears touched assignments. | Half-point additions; ownership-aware cross-month workflow; no silent loss of locks/emergency cover or old-target reuse after a weight change. |
| Arithmetic | JavaScript numbers; SQL `numeric`, without a half-step database invariant. | Exact half-point units in all core calculations and future persistence validation. |
| Publication | Checked, revision-protected draft/publication separation and immutable versions. | Preserve it; commit ledger origins and repayment plans atomically with authoritative publication changes. |

Current regressions that intentionally change include ignored legacy locks,
emergency points, month-independent gaps and the absence of compensation.
Current coverage, identity, ownership, permission, consent, revision and version
protections remain mandatory.

No tests currently demonstrate the proposed ledger or a globally optimal
schedule. Current published swap approval preserves duty weights, secondary
coverage, working drafts and prior versions; it creates a new current publication.
The redesign must integrate with that operation rather than count every copied
historical version as new work.

## 3. Canonical duties, ownership and time

### 3.1 Terms

| Term | Meaning |
|---|---|
| Duty block | An indivisible primary coverage interval. At most one primary engineer; empty only in an unfinished/partial draft. |
| Ordinary duty | Normally one date at 09:00 through the next date at 09:00. |
| Combined weekend | Friday 09:00 through Sunday 09:00: one block covering Friday and Saturday. |
| Split weekend | Separate Friday and Saturday daily blocks with the same Friday weekend identity. |
| Special Block | Configured daily additions over a range, not one indivisible multi-day duty. |
| Owner month | Friday's month for either weekend half; otherwise the duty date's month. |
| Target | Final confirmed primary points. Exact in a complete result; a strict ceiling with visible shortfall in a partial result. |
| Lock | Explicit manager-fixed primary assignment; persists until explicitly changed/unlocked. |
| Obligation | A directed debtor-to-creditor claim for future workload, measured in exact points. |
| Planned repayment | Reserved future duty-point capacity for an obligation; does not settle it yet. |
| Actual settlement | Repayment earned by completed duty capacity, or an explicit audited manual settlement. |
| Projection | A simulation of known published commitments finishing normally by a defined future cutoff. |
| Ordinary baseline | The proposed normal allocation before compensation and current temporary/permanent adjustments; not a historical debt score. |

Duty ranges are start-inclusive and end-exclusive. Date-based unavailability
applies to every covered duty date, including Saturday in a combined weekend.
A display label cannot truncate the true coverage range.

Convert the established 09:00 handovers in `Asia/Jerusalem` into actual instants
for completion and elapsed-time spacing. Use the actual local offset on each date,
not a fixed UTC offset or an assumption that every local day is 24 hours.
Represent gaps as integer elapsed minutes; no floating equality is needed.

The operational opening instant of a month is the earliest start of its required
canonical **owned** duty blocks: `coverageStart(M) = min(startInstant[d])` for
all blocks owned by M. Normally this is 09:00 on the first owned duty date. If
the calendar month starts Saturday, that is Sunday the 2nd. Derive it from the
required calendar coverage, regardless of assignments, locks, publication or
draft status; removing assignments cannot move this instant.

This is both the opening cutoff for compensation projection and the V1
Generate/Regenerate cutoff: generation is allowed only while authoritative
`now < coverageStart(M)`. At equality coverage has started. The projection
includes the prior owner's duty finishing at the same handover, without treating
a duty as finished before its actual end. Section 15.4 defines enforcement.

### 3.2 Friday ownership and structure

**Friday owns both weekend dates**, including Saturday in the following month
or year. Friday 31 December 2027 and Saturday 1 January 2028 belong to December:

- Combined: one block ending Sunday 2 January at 09:00.
- Split: two blocks sharing weekend identity 31 December, both December-owned.
- January treats that coverage as fixed context; it cannot generate or count
  1 January again.

Count each canonical duty and each covered date once. The month total and coverage
objectives use owned dates, including the owner's cross-month Saturday. Sunday at
the exclusive end is not a third covered date.

Generate preserves the explicit combined/split structure and Special Blocks.
It cannot split, merge or reweight duties to improve its result. Representation
normalization outside Generate is allowed only when it preserves primary and
secondary coverage, points, owner, lock/exception meaning and accounting lineage.
In particular, separate special daily duties cannot be merged to evade adjacency.

The existing calendar may omit a leading Saturday row and show other neighboring
dates read-only. Visible cells are not the ownership or solver-input authority.

### 3.3 Points

| Duty | Primary points |
|---|---:|
| Ordinary weekday | 1 |
| Combined Friday–Saturday | 1 total |
| Split Friday | 0.5 |
| Split Saturday | 0.5 |
| Special daily duty | Its weekday/weekend base plus that date's configured extra |
| Emergency/secondary cover | 0 |

Special extra points are per covered date and must be nonnegative multiples of
0.5 within existing product limits. Reject 1.1; never silently round it.
Two special weekend dates with +2 each weigh 2.5 + 2.5 = 5, sharing one weekend
identity. A Special Block may cross month boundaries; resulting duties retain
their owners.

Use integer half-point units throughout the pure core:

`q[d] = 2 × points(d)`, `t[e] = 2 × Target(e)`.

One point is 2 units; half a point is 1; 34.5 points is 69.
Validate denominations and safe integer bounds at the input boundary. Integer
units do not authorize splitting physical duties; an assigned block still goes
to one primary engineer.

## 4. Exact targets, structural validity and partial accounting

Let `D(M)` be the unique required duties owned by month `M`. Define:

`P = sum(q[d] for d in D(M))`

`sum(t[e]) = P`

Include every required duty whether locked, assigned or empty. Exclude neighboring
owners and emergency assignments. Locked points are already inside `P`, not added
again.

For each engineer:

`l[e] = sum(q[d] for their valid locked duties in D(M))`

`r[e] = t[e] − l[e]`

`a[e] = sum(q[d] for their assigned primary duties in the result)`

`m[e] = t[e] − a[e]`

Require `0 <= l[e] <= a[e] <= t[e]` and `m[e] >= 0`.
Display values in points; solve and account in units.

| Meaning | Invariant |
|---|---|
| Remaining before generation | `r[e] = t[e] − l[e]`. |
| Complete result | Every duty covered and every `m[e] = 0`. |
| Partial result | Some duties empty, with per-engineer `m[e]` visible. |
| Workload conservation | `sum(m[e]) = sum(q[d] for unassigned d)`. |
| Calendar coverage | Count covered dates, separately from points. A combined weekend covers two. |

With target totals equal to `P` and no engineer above target, full duty coverage
implies exact targets. Conversely, a positive shortfall cannot disappear by
changing the target sum after generation.

### 4.1 Reject invalid inputs; allow unattainable ones

**Structurally invalid:** wrong target sum, negative/off-denomination targets,
missing required identities, ineligible locked primary, invalid canonical
coverage, conflicting fixed locks without the specific required approval, or
locked points above target. Disable Generate and explain the repair.

**Structurally valid but incomplete allocation:** weighted targets cannot all be
attained, some engineers/dates unavailable, shared capacity insufficient,
consecutive restrictions or weekend caps prevent full coverage. Keep Generate
available; show the known limitation and produce valid partial output.

Target 3 / Locked 1 leaves 2 to generate. Target 3 / Locked 3 permits no more.
Target 3 / Locked 4 is invalid. Target 3 with only a 4-point candidate is valid
input for partial generation: that engineer receives no oversized duty and
retains the unmet 3.

### 4.2 Changes invalidate derived results

Targets and validation are versioned against the actual duties, weights, locks,
constraints, neighboring context, membership, allocation/compensation snapshot
and solver settings. Any relevant change invalidates a stale preview/result.

A special/structure edit changing `P` does not silently rewrite confirmed targets.
Mark allocation review required, preserve manager edits for display, recalculate
the total, and reopen the existing allocation popup. Offer a fresh proposal as
an explicit manager action. Generate remains disabled only while the totals or
other structural invariants are invalid.

A cross-owner Special Block is expanded into owner-scoped changes. Preview all
affected months inline; use their existing authorized draft transitions and
one atomic revision-checked operation for the explicitly reviewed scope.
A published neighbor is not silently reopened. Until the manager explicitly
opens/reviews each affected owner, reject that portion rather than mutate history.
Generating one month still writes only that owner. An edit touching a lock
requires explicit review of the changed locked duty/points, never automatic
unlocking; preserve secondary coverage.

## 5. Ordinary fairness and compensation-aware proposals

> **Superseded for the allocation preview (decision 2026-10-30).** Plan the month
> no longer solves. Its proposal is synchronous arithmetic: equal ordinary shares
> with remainders newest first; open obligations repaid oldest first, capped by the
> debtor's availability ceiling and the creditor's locked floor; locks as floors.
> A simple per-member availability ceiling (available covered duties, no
> back-to-back duties) warns inline and never blocks. Generate is the only solver
> step and the exact check, and keeps partial results. The global-model proposal
> and feasibility proofs described in sections 5–6 below are kept as the original
> design record. Current behavior: [ALLOCATION_PLANNER.md](ALLOCATION_PLANNER.md).

### 5.1 Ordinary baseline

Calculate a baseline `B[e]` in half-point units, summing to `P`, before adding
compensation. Eligible active approved engineers participate, including an
eligible manager. Seniority order is the saved team order.

Use approximately equal workload. The engineering formulation is to minimize
`sum((n × B[e] − P)^2)`, where `n` is the number of participating engineers.
This compares rational averages exactly through integer expressions. A linear
one-hot representation of attainable per-engineer point totals can express the
same discrete cost; quadratic-solver support is unnecessary.

Retain equivalent minimum-cost baseline vectors until compensation feasibility
has been evaluated; a seniority tie must not prematurely prevent repayment.
Among otherwise equivalent compensation outcomes, prefer giving the indivisible
remainder to newer engineers, proceeding newest to senior with stable identity
as the final tie. Seniority never multiplies workload and cannot override
compensation or feasibility. With no compensation and 8 ordinary points for
three otherwise equivalent engineers, senior-first 2, 3, 3 is preferred to 3, 3, 2.

Use canonical weights to select ordinary target combinations; a three-point
block is not three interchangeable one-point slots. This baseline expresses
ordinary responsibility, before personal temporary availability relief,
compensation and deliberate manager changes. Assess the **offered allocation**
against actual availability, identities, adjacency, weekend capacity and locks
using the global model.

When availability requires default relief, represent it as explicit pending
temporary counterpart transfers from B, shown inline for manager confirmation;
do not redefine that engineer's ordinary share as zero and lose the future
compensation. Ordinary remainder choices still create no debt.

> **Decision 2026-10-30: uneven months are credited.** When the indivisible
> duty weights force the exact minimum-cost partition above the plain equal
> split (14 days at +2 among 12 engineers: six at 4 points and six at 5), the
> extra half point is **temporary** compensation. The members with the fewest
> points that month owe it, most senior first; those above the split receive
> it, most points and most senior first. It is stored with the allocation as
> system transfers (`uneven`), verified exactly by the database, published as an
> ordinary temporary claim and repaid like any other. A remainder given to a
> different member (same multiset as the plain split) still creates no debt.
> **Refinement 2026-10-31:** the credit follows the real permanent load. A
> creditor is credited only for the extra it still carries after its net
> permanent loss, and a debtor owes only while still below the split after its
> net permanent gain; a Permanent −0.5 on a creditor that lands on its debtor
> leaves both at the equal share and no debt. The pairing is derived under the
> current seniority at every confirmation, so a reorder after confirming never
> traps the month, and a new proposal keeps the confirmed baseline.
> See [ALLOCATION_PLANNER.md](ALLOCATION_PLANNER.md#proposal-decision-2026-10-30).
Locks are final-target floors; do not redefine ordinary fair work as already
locked workload and erase the ability to credit a locked repayment. If locks
exceed the offered normal/compensation target, preserve them and require the
manager to classify/approve the target increase.

If no full schedule exists even with freely chosen targets, retain a balanced,
nominal baseline and structurally valid offered totals summing to `P`; use known
attainable totals where possible and explicitly flag unavoidable shortfalls.
Do not derive the target total from only the coverable part of the month.
A timeout leaves the proposal unproved, rather than establishing impossibility.

Ordinary baseline differences and random date choices do not themselves create
obligations. Only explicitly recorded/confirmed temporary transfers, authoritative
published workload transfers and manual ledger operations do. The baseline is
stored with the allocation so it is not recomputed later to manufacture history.

### 5.2 Compensation has priority

Read actual obligations, simulate published work through the selected month's
operational opening, normalize the resulting graph and propose repayment of the
oldest feasible units. There is no fixed monthly repayment cap.

For an ordinary normalized obligation `debtor D -> creditor C`, proposed
repayment `s` increases D's target by `s` and decreases C's by `s`.
The transfer preserves the monthly total. Targets cannot fall below locked
points or zero. Repayment must be achievable using actual duty-weight
combinations; a fraction of a block cannot be assigned independently.

After choosing among equivalent ordinary-fair baseline vectors for maximal
oldest-feasible repayment, hold the selected baseline fixed. Do not choose a
less-fair inflated creditor baseline merely to subtract it again and claim
more repayment. Compensation
feasibility is assessed globally before ordinary balance and seniority tie-breaks.
If a full schedule is achievable, a default compensation proposal must preserve
that ability. If full coverage is inherently impossible, use the attainable
coverage model and clearly identify unproved/unfunded proposed work.

Maximize feasible repayment of the oldest obligation's units, then the next,
with partial amounts permitted. An older infeasible obligation remains open;
another feasible obligation can progress. Feasibility is not inferred solely
from the debtor's available-date count.

Both debtor capacity and creditor relief matter. A creditor with a 2-point
baseline and no reducible additional allocation cannot receive 4 points of
relief without a negative target. This is a real allocation restriction, not
an arbitrary repayment cap.

### 5.3 Final authority

Let `F[e]` be the baseline plus planned compensation, before current
temporary/permanent transfers. Availability-driven relief belongs to
`temporary[e]`; the popup shows the final value after all components:

`Target[e] = F[e] + temporary[e] + permanent[e]`

This is a UI allocation identity, **not** a formula that independently creates
ledger entries. Store linked counterpart transfers and purpose, not just scalar
monthly differences.

The manager may defer repayment by lowering a Target temporarily. Recompute
the proposed repayment plan against the resulting targets; keep unperformed
obligations outstanding. Generate receives the confirmed table and never
repays extra points by exceeding a lowered target.

Use consistent direction: an engineer who **owes** 3 points may be offered
normal 2 + repayment 3 = 5. An engineer who **is owed** points receives less work
when a debtor repays. The earlier Daniel example's word “owed” is interpreted
as “owes” to preserve the explicit pairwise model.

## 6. Temporary and permanent allocation adjustments

*Decision 2026-10-31:* the draft stores one net Temporary and one net Permanent
change per member instead of a history of edits. Points = fair baseline (plus
planned repayments) + Permanent + Temporary. The automatic counterparts of 6.1
are recomputed from scratch from that state on every edit, across members
without hand changes only, so the result is order independent; the floors are
fair + Permanent ≥ 0, Permanent never below planned relief, and Points ≥ Locked;
the transfer list is derived (drag pairs first, then netted) and the database
re-derives and requires it. See [the planner](ALLOCATION_PLANNER.md).

The manager sees Points, signed Temporary and Permanent changes, Locked and
To schedule. Keep internal provenance without exposing several fairness counters.
Temporary and Permanent changes can coexist.

| Kind | Meaning | Ledger effect |
|---|---|---|
| Temporary | Vacation, unusually limited availability, requested relief or spreading work over future months. | A new ordinary burden carried for someone creates a linked obligation on publication. Deferring an existing repayment leaves that obligation outstanding; it is not a second copy of the debt. |
| Permanent | Volunteering, a disciplinary allocation or another intentional non-compensated workload transfer. | Both sides are exempt from new compensation. It does not forgive an existing obligation or settle one without completed repayment/manual settlement. |

### 6.1 Redistribution mechanics

Use deterministic half-point transfer units internally, even when a button edit
requests one full point. Try the whole requested amount first; if that cannot
be placed, distribute 0.5-point units in preference order, checking the resulting
global model. The requested total change and every counterpart are shown inline.

- Temporary decrease: scan forward from the engineer in seniority order, wrap
  once after the newest, exclude the source, and skip ineligible recipients.
  Continue until the requested amount is placed or the candidate set is exhausted.
- Temporary increase needing a donor: select an eligible highest-current-target
  donor, most senior first on a tie; repeat as needed.
- Permanent increase: use the agreed highest-current-target donor preference,
  most senior among eligible ties. Re-evaluate ranking after each transfer.
- Permanent decrease: distribute to eligible lowest-current-target recipients,
  newest first on a tie, preserving approximate balance.

For the permanent operations, every counterpart transfer is also permanent.
Never reduce a target below its locked points. Never mix the classifications
of the two sides of one transfer.

*Superseded 2026-10-30:* automatic counterparts are now chosen by the ranking
above, skipping hand-edited members and lock floors only, without a feasibility
probe; the row's availability warning and Generate replace it. Originally:
an automatically selected recipient must be able to accept the increment under
global duties/weights/availability constraints. Prefer a full-feasible
redistribution when one exists; when the month is already inherently partial,
require evidence that the recipient can actually carry the proposed increment
without degrading the already attainable higher coverage priorities.
UNKNOWN is not proof of a recipient's infeasibility.

### 6.2 No hidden edit rejection or silent limit increase

*Since 2026-10-31 an unplaced change is simply the member's net change without a
counterpart; it shows inline and blocks confirmation until another member's
change or a drag balances it.* Originally:
if automatic redistribution cannot finish, retain the manager's requested limit
as a pending table edit and show the unbalanced monthly total inline. The manager
can place the remaining nominal points explicitly with other Target controls,
even where that final allocation knowingly requires partial output.
Unallocated units retain their source and temporary/permanent classification.
Subsequent edits consume that pending transfer before initiating another donor
search. Generate is disabled until the table is structurally balanced.

This separates two facts: automatic redistribution must not pretend an
unavailable recipient can carry work, while a manager may confirm a balanced,
infeasible table and obtain a partial schedule. No automatic fallback can raise
the original engineer's reduced target.

### 6.3 Compensation deferral is not a new copy of an old debt

Compile the final targets into a repayment/transfer plan after all edits.
Allocate the available repayment budget oldest first; defer the rest.
Track ordinary temporary burden separately from units that merely replace a
deferred repayment. Preserve the approved counterpart trail through the debt
network rather than posting every button press as an independent new debt.

For example, after a debtor's target is reduced by 1, another engineer might
carry that point while the original creditor keeps the planned relief.
That re-routes the remaining obligation through the recorded counterpart chain;
it must not leave the original full shortfall **and** create another full debt
for the same missing repayment unit. See the numerical example in section 16.

Permanent adjustments create no new claim, including when they reduce capacity
previously proposed for repayment. Re-plan/defer that repayment; do not treat
the permanent edit itself as a settlement or debt forgiveness.
No duty-point unit may be earmarked twice to fund these purposes.

## 7. Linked compensation ledger

### 7.1 Direction and conserved net positions

`D -> C : q` means **D owes C q units**: D should carry future extra workload
that would otherwise fall to C, subject to confirmed targets and hard constraints.
It is a workload claim, not money, availability permission or an assignment lock.

For engineer `e`:

`net[e] = incoming outstanding units − outgoing outstanding units`

Positive means owed workload relief; negative means owing future workload.
Display points: `+2` means owed 2; `−1` means owes 1.
Across the entire ledger, including inactive engineers, `sum(net[e]) = 0`.
Do not normalize each engineer independently and lose counterpart links.

Every active obligation has distinct valid debtor/creditor identities,
nonnegative integer units, origin, creation/effective timestamps, original
amount, subsequent adjustments, source/reason and settlement provenance.
Zero outstanding amount means closed/netted/settled, not erased history.

### 7.2 Minimal persistence and event contract

Recommend **one append-only compensation event table**, plus versioned allocation/
repayment metadata on existing month/publication records and lock fields on
existing duty rows. Avoid separate tables for each obligation, projection,
balance, daily job and settlement counter. This is a migration design
recommendation, not DDL or an implemented schema.

An event contains a stable ID, a unique source/idempotency key, transaction/order
sequence, recorded and effective time, actor/source, mandatory reason where
manual, and validated integer-unit lines referencing engineer IDs and original
lots. Event kinds cover obligation creation, manual increase/reduction,
actual settlement, and explicit correction/reversal.
Participation freeze/unfreeze markers can use the same event stream; no
separate membership-history service is needed. Source creation times come
from checked authoritative operations, not arbitrary client backdating.

Replay committed events by immutable transaction/line sequence. Effective duty
times determine earning eligibility and source age, not permission to reorder
already committed netting/freezes. A late historical correction appends a
referenced adjustment at the current sequence, preserving the original source
age where appropriate; it does not insert a new event into old business order.

Use a typed, validated payload for multi-line provenance when necessary.
Database constraints/checked operations validate referenced members and totals;
an unvalidated client JSON blob is not an accounting authority. Foreign keys
must not cascade away compensation when a publication/version is deleted.
Keep a stable source operation/slot snapshot independent of physical version
row IDs, which change when publications are copied.

Replay produces raw outstanding source lots, normalized obligations, net
indicators and auditable settlement history. Materialized balances are not
needed initially. An optional later cache must be a disposable projection,
never a second authoritative ledger.

Publication and automatic obligation creation commit in the same existing
revision-locked transaction. Retrying one source operation cannot append its
amount twice. Corrections append compensating events referencing the original;
they do not overwrite/delete original events or rewrite later schedules.

### 7.3 Origins: published commitments and explicit manual operations

| Source | Effect |
|---|---|
| Ordinary published replacement: Daniel's 2-point duty goes to Noam | Daniel owes Noam 2. Retain old/new duty facts and source publication transition. |
| Noam replaces Daniel on an uncompleted 2-point duty reserved to repay Daniel's existing 2-point debt to Noam | Cancel that repayment reservation; Daniel still owes Noam exactly 2. No new obligation for those units. |
| Published weighted swap: Daniel 1, Noam 3 become Daniel 3, Noam 1 | Noam owes Daniel 2. Record the net transfer once, not both a 3-point and 1-point independent charge plus another reconciliation. |
| Equal-weight published swap | No new obligation. |
| Confirmed ordinary temporary transfer | Pending intent while draft; on first authoritative publication, create the linked claim for the accepted transferred workload. |
| Permanent transfer | No claim for either side; preserve its explicit exemption with that publication. |
| Normal initial allocation or a different random arrangement | No claim merely for ordinary point differences, dates or seniority remainder. |
| Manual compensation operation | Explicit audited event with selected counterpart and reason. |
| Draft replacement, swap, regeneration, reopen or cancelled draft | No obligation and no actual settlement. |

Compare one authoritative publication transition with its predecessor by stable
owner/slot identity, dates and weights. Do not sum versions or regenerate a
monthly “fairness delta” as a second source of debt. First publication applies
its explicit temporary intents once; it does not infer obligations from every
difference from an ideal average.

Reopening a published month preserves its committed transfer history. Repeated
publishing carries unchanged intents/slot lineage forward instead of creating
them again. Changed ordinary responsibilities produce only their new delta.
Weight-only changes or additional required work have no invented debtor;
review allocation/intent explicitly rather than fabricating a zero-sum transfer.

Permanent exemptions belong to their original approved transfer; they do not
make a duty immune from future ordinary compensation if its primary changes.

For comparison only, expand a combined weekend into two owned date atoms of
0.5 base points each; keep real duty blocks indivisible for assignment and
completion. This makes combined-to-split transitions conserve the same point
capacity. If only Saturday moves from A to B, its ordinary transfer is A -> B
0.5, not another full weekend point. With simultaneous weight changes, only
shared old/new committed capacity transfers automatically; newly added/removed
units require reviewed allocation intent, not an invented debtor. Actual
repayment timing always follows the final real duty block's end.

**Cancelled repayment:** when the creditor replaces the debtor on an uncompleted
published duty earmarked to repay that same obligation, cancel the affected
repayment reservation. Keep the original outstanding obligation unchanged; the
attempted repayment is neither earned work nor a new transfer charge. Record the
authoritative cancellation and attribution lineage for audit, without deleting
the original claim or reversing an actual settlement that never happened.

Classify the cancelled repayment units before calculating the ordinary
replacement/weighted-swap transfer. Do not charge them again through gross duty
value, monthly reconciliation or repeated publication copies. Any separate
ordinary workload transferred beyond the cancelled repayment component remains
subject to the ordinary transfer rules, as illustrated in section 16.13.
Completed/earned settlements are not pending reservations; exceptional
corrections to them retain the separate audited correction rules.

### 7.4 Deterministic network normalization

Normalize outstanding **active-participant** claim segments as a pure derived
view during committed-transaction event replay. Retain edges frozen at membership
transitions separately. Original source lots remain audit provenance; do not
reconstruct a different freeze from only today's membership and all raw history.
Use integer amounts; never rely on database row order.

1. Sort source lots by original effective creation time, immutable source
   sequence and lot ID. Stable engineer IDs break otherwise identical choices.
2. Cancel opposing directed amounts using the minimum available units.
3. Find directed cycles deterministically using sorted vertices/edges; subtract
   the minimum amount on the selected cycle. Repeat until acyclic.
4. In a stable topological order, bypass a vertex that has both incoming and
   outgoing flow: `X -> Y : a`, `Y -> Z : b` become
   `X -> Z : min(a,b)`, with residual legs preserved. Match source segments
   FIFO. Continue until no active vertex is both an intermediary debtor and
   creditor.
5. Coalesce equal endpoint pairs for display, keeping their separately aged
   provenance segments for repayment.

Each cancellation/bypass records its contributing source segments in the
derived explanation. Bypass amounts inherit the oldest contributing source
priority; residual portions retain their original ages. A path's later legs
remain in the audit trail. Never reset an old claim's age by normalizing,
reactivating, republishing or re-projecting it. An increased amount is a new
dated segment, not newly added work falsely backdated to an old lot.

Cycles are eliminated before bypassing, so shortening follows an acyclic graph
and terminates. Normalizing an already normalized view returns the same view.
The chosen stable algorithm need not minimize the number of transfers globally;
it must preserve every engineer's net position, avoid self-debts and produce
identical amounts/provenance from identical inputs.

Required examples, in points:

- X -> Y 2 and Y -> X 1: X -> Y 1.
- X -> Y 1 and Y -> Z 1: X -> Z 1.
- X -> Y 2 and Y -> Z 1: X -> Y 1 plus X -> Z 1.
- X -> Y 1, Y -> Z 1, Z -> X 1: zero active obligation.

Netting is not an invented completed duty. Show it as netted/cancelled by
normalization while preserving the underlying events. Display and future
allocation use normalized claims, not gross unnetted totals.

### 7.5 Repayment, age and point capacity

Repay the oldest feasible normalized segments first, allowing 0.5-point partial
amounts. No arbitrary monthly limit or expiry applies. Feasibility is constrained
by both parties, the fixed baseline/locks, available weighted combinations and
the complete global assignment model.

A repayment of `q` changes the debtor's net position by `+q` and the creditor's
by `−q`. A normalized transitive repayment references and reduces the same
quantity on every contributing raw path leg. This reduces each endpoint's claim
once and leaves intermediaries' net positions unchanged; it is not several
independent repayments of the same work.

A normalized segment retains origin priority through partial settlement. A
blocked oldest segment can be skipped for this proposal without losing its
priority next time. Stable source order resolves equal-age feasibility ties.

Attach a published repayment plan to specific debtor duty-point units.
For each primary duty, the sum of repayment/transfer attribution cannot exceed
its weight; a unit cannot settle two claims or create a duplicate claim.
An accounting slice may be 0.5 of a larger duty; the primary assignment remains
indivisible. Allocate reserved units to chronological duties, then source age
and stable IDs, and retain that attribution through unchanged publication copies.

An obligation of 0.5 cannot be rounded to 1. If only whole-point target
combinations exist, defer it unless another explicitly reviewed adjustment
makes the half-point repayment realizable without overpayment.

### 7.6 Actual and projected settlement

An obligation created by an authoritative published workload transfer is a
confirmed claim immediately; its source duty may still be future. “Actual
balance” means confirmed claims less earned/manual settlements, not a claim
that all future source duties have already been performed. Projection adds
assumed future repayment effects without marking them actual.

An automatic repayment becomes actual only when its attributed primary duty
has ended: `duty.endInstant <= authoritative now`. Normally this is 09:00
on the exclusive end date. Publishing reserves a repayment; it does not settle
it. A two-day combined weekend never settles halfway through on Saturday.

An explicit manual settlement/correction is a separately authorized exception,
with reason and event history; it does not pretend a duty was completed.

For early generation of month M:

1. Reconcile completed authoritative duty facts through server time.
2. Copy the actual ledger state into a projection.
3. Apply valid, already published and not-yet-completed repayment plans whose
   duties end by M's operational opening. Assume those commitments finish normally.
4. Normalize and propose M's allocation from that projected state.

Never project settlements from an unpublished draft, obsolete historical version
or duty ending after the cutoff. Store actual state, projection cutoff and
source fingerprints separately. Projection is not an append of settlement events.
Users indicators show actual balance; a next-month estimate is explicitly labeled
when displayed. The allocation popup can concisely explain that known published
work before the month is included.

### 7.7 Lazy, idempotent reconciliation and later changes

Reconcile on Generate, Users access and relevant checked publication/manual
operations. No daily background job is needed.

Under the existing workspace lock, use one server time and canonical current
publication facts; replay committed events in transaction/line order. Process
newly due plan contributions in actual end-time and stable source order before
the next discretionary mutation. Append each missing settlement once using
a unique contribution/source key. Concurrent tabs or repeated reads must not
settle it twice. A read without authorized mutation access may obtain a derived
view; it cannot grant itself ledger write permissions.

If an uncompleted published duty changes, cancel/rebind its projected repayment
attribution according to the authoritative transition. Projection is recomputed,
not “undone” by adding compensating actual debt for a settlement that never
happened. If the creditor replaces the debtor on the repayment-bearing units,
apply section 7.3: the original debt remains, with no new obligation for those
units. Those cancelled units no longer reduce the projected balance or earn a
later settlement, including after the replacement duty ends.

A lazy update affects the next allocation proposal, not an already confirmed
target table or published future month. If October changes after November was
published, November stays intact. Correct the underlying facts/projection and
consider the revised obligation at the next Generate.

Completed facts and ledger origins must survive ordinary publication copying,
history-preview access and version deletion. If an exceptional authorized
historical correction changes a previously recorded fact, append a reasoned
correction/reversal with stable lineage, replay affected settlement dependencies
and append the required differences exactly once. Preserve previous events
and all later published schedules. Do not infer that deletion alone forgives
earned obligations or build a general retroactive rota editor.

### 7.8 Inactive and new engineers

Do not delete or reassign inactive engineers' claims. At deactivation, freeze
currently outstanding normalized segments whose debtor/creditor is that person:
no automatic repayment and no new transitive routing through that endpoint.
New source claims involving an already inactive endpoint enter the frozen pool.
This specific freeze rule takes precedence over general active simplification.
Keep frozen edges in counterpart details and global net positions.

Do not undo valid earlier netting merely because an inactive person occurs in
its historical provenance. If X -> Y -> Z already became X -> Z while all were
active, Y's later deactivation does not freeze X -> Z: Y is no longer a required
participant. Replay the source/normalization/freeze sequence deterministically,
retaining its proof, rather than rebuilding from current raw endpoint flags.

An inactive intermediary may display net 0 while retaining two frozen
relationships; show that fact in its details. Unrelated active obligations
continue. Reactivation restores participation and original ages/history.
New engineers start with no invented historical claims. Exceptional admin
resolution requires a reasoned manual event; no replacement debtor is invented.

Reconcile earned work under the same lock **before** deactivation freezes
participation. Never undo an already earned settlement merely because someone
is now inactive. A pending repayment requiring inactive participation is held
out of automatic projection/settlement; completions during that freeze need
explicit reviewed resolution, rather than automatic retrospective payment on
reactivation. Record freeze intervals so lazy access time cannot change this
outcome.

### 7.9 Users tab and manual operations

Show a simple signed compensation indicator per engineer in the existing Users/
Team view, plus compact expandable counterpart details. Positive means owed
relief; negative means owes. This is not a financial management screen.

Use + / − controls with a selected other engineer. Explain direction inline:
increasing A's positive indicator creates/increases **B owes A**; decreasing it
reduces that selected claim or explicitly creates the reverse relationship.
Do not silently cross through zero and invent a reverse obligation. Show the
proposed direction/amount before applying the existing inline operation.

Reuse exact 1-point/default and 0.5-point step controls. Approved active members
may inspect team net indicators and linked counterpart amounts. Restrict the
full discretionary correction/reason audit to managers; availability notes never
enter compensation payloads. Manual mutation requires checked manager authority.

Support creation, increase, decrease, full/partial settlement and correction.
Require a reason for manual corrections or settlements; use a required concise
reason field for other manual ledger events as well to keep the audit coherent.
Preserve original events. All manual obligations normalize, freeze, project and
repay exactly like automatic ones.

### 7.10 Accounting invariants

- Every obligation/adjustment has two valid distinct endpoints and exact units.
- `sum(net[e]) = 0`, including inactive endpoints.
- Normalization preserves each net position and original event history.
- No negative outstanding lot, over-settlement or duplicated source is allowed.
- Draft-only changes create neither obligations nor completed repayments.
- Future published repayments affect projections, not actual settlements.
- Permanent intent produces no new compensating debt/credit.
- A published transfer is accounted once: explicit event/intent **or** its
  recognized delta, never an additional monthly score reconciliation.
- Actual settlement consumes real completed, attributed capacity at most once.
- A plan, projection, publication copy or source-row ID change is not new work.
- A stale client cannot overwrite new ledger state, targets or schedule facts.
- No correction automatically rewrites another month's published assignments.

## 8. Allocation popup and manager experience

Use one compact, mobile-first popup before solving. Sort engineers most senior
first. Preserve English LTR, Hebrew RTL, keyboard access, labels and modal focus
behavior.

| Column | Meaning |
|---|---|
| Engineer | Name in saved seniority order. |
| Points | Final monthly primary points: fair share (plus repayment) + Permanent + Temporary. Display only. |
| Temporary | Signed net compensated change (stepper). |
| Permanent | Signed net intentional non-compensated change (stepper); already included in Points. |
| Locked | Full points of fixed primary assignments owned by this month. |
| To schedule | Points minus Locked; remaining requested points, not a promise they are attainable. |

Use + / − buttons, defaulting to 1 point every time the popup opens, with a
small 0.5-point step toggle. Show configured total versus required month total.
Keep temporary/permanent and counterpart effects concise and inline.
Do not add another popup just to explain adjustments, validation or conflicts.

After generation show actual assigned points and unmet points alongside the
retained targets, with uncovered dates listed inline. Never replace Target with
the achieved amount or hide unfulfilled work.

### 8.1 Validation and actions

- In V1, disable Generate and Regenerate once owner-month coverage starts, with
  concise inline text directing the manager to manual changes or swaps. This is
  a time/scope restriction, separate from mathematical feasibility. Other actions
  retain their existing authorization and integrity checks.
- Structural invalidity disables Generate with a specific repair message.
- No solver runs while editing (decision 2026-10-30; previously complete-feasibility
  checks ran in the background and known infeasibility enabled **Generate partial**).
  A row whose target exceeds its simple availability ceiling shows one short
  inline warning; it never blocks.
- **Confirm & generate** always runs the exact global optimization for the
  confirmed targets and saves a partial result when full coverage is impossible.
- Adjustments & compensation lists netted temporary relationships (debtor →
  creditor, what is repaid this month and what carries forward), display only.
- During an active generation/save, prevent duplicate submissions; offer Cancel
  while solving. Editing inputs cancels/invalidates the old request.
- Timeout with a verified incumbent can produce a draft labeled with its actual
  coverage and “Best found; search limit reached.” Never claim proven optimality.
- No verified result, a runtime failure, cancellation or a stale source leaves
  the accepted draft unchanged and provides a clear retry message.

Partial output is prominently **Partial / Requires Manager Resolution**.
A complete result can say “All duties covered”; “Optimal” is only appropriate
for objective stages with proof. Low-level bounds and solver terms belong in
diagnostics, not primary manager copy.

Within the V1 generation window, the manager can change temporary/permanent
targets, explicitly select/lock a duty including a permitted override,
unlock/change a lock, and Generate again.
An uncovered duty is a visible action item, not a silent availability exception.

After that window closes, manual resolution and swaps remain available through
their existing checked workflows; no full-month or remainder-only generation is
available in V1. Do not disguise immutable history as a manual lock.

## 9. Locks and scoped manager overrides

### 9.1 Persistent primary locks

Lock/Unlock is an explicit manager control. A lock fixes the primary, canonical
block and full points until explicitly changed. Save/reload, Generate and
Regenerate preserve it. Its points consume the engineer's target first.

Ordinary unlocked manual edits and draft swaps do not become locks.
An intentional assignment on an unavailable covered date must record the
manager override and **lock that specific assignment**, retaining the engineer's
unavailability. Solver-created assignments cannot acquire override permission.

Persist locks/exceptions with draft rows and copy them with publication/restore
metadata. Cancel Draft still discards that draft as an explicitly requested
lifecycle operation; it does not delete immutable published history or ledger
events. Regeneration is not Cancel Draft and cannot discard locks.

### 9.2 Explicit exception scope

| Rule | Allowed manager exception |
|---|---|
| Availability | Only the specifically assigned/locked duty and recorded unavailable dates. |
| Consecutive duties | Only the explicitly reviewed conflicting fixed pair involving a manager lock. Both duties must remain fixed; no automatic new adjacent assignment is authorized. |
| Adjacent-month consecutive conflict | The selected-month manager lock may explicitly acknowledge the identified fixed neighboring duty. Do not edit or mark the neighbor overridden. |
| Additional weekend | Only the reviewed locked weekend assignment(s); no general relaxation of the engineer's cap. |
| Target ceiling, eligibility, primary/secondary identity, canonical non-overlap, authorization/revision/history | No automatic or generic scheduling override. |

For an engineer with approved locks on two distinct weekends, retain those
specific weekends; do not allow the solver to add a third. Without a locked
weekend, the normal one-weekend allowance applies. An availability-only lock
cannot approve a second weekend or a consecutive pair.

Store rule-specific approval scope and reason through the existing checked
manager workflow. A legacy generic `manager_override` flag alone cannot express
all new permissions. Approval is not a new solver variable.
If a duty/identity/range changes, revalidate the exception's exact scope.

### 9.3 Fixed-input checks

Reject locked points above target, inactive/missing primary identities, invalid
or overlapping canonical blocks, invalid same-person secondary identity and a
fixed conflict lacking its required specific approval. Partial generation can
leave unlocked duties empty; it cannot repair contradictory mandatory locks by
dropping one.

A lock may consume another engineer's only feasible opportunity. That is a
complete-feasibility restriction, not a reason to alter the lock: produce the
best valid remainder and show its consequence.

## 10. Hard automatic constraints and neighboring context

Every generated assignment, complete or partial, satisfies:

| ID | Invariant |
|---|---|
| H1 | Each canonical owned block is assigned to at most one primary; unassigned blocks are explicit. A complete result covers all. |
| H2 | Assigned primary points never exceed the confirmed target; complete coverage implies every target is exact. |
| H3 | Automatic primaries are active approved eligible members and available on all covered duty dates. |
| H4 | Explicit primary locks and narrowly scoped approved fixed exceptions are preserved. |
| H5 | No automatic consecutive primary duties, including conflicts with fixed context. |
| H6 | At most one distinct primary weekend per engineer per owner month, except the explicitly approved locked weekends. |
| H7 | Canonical combined/split structure, weights, actual intervals and Friday ownership remain unchanged. |
| H8 | Other months' assignments, locks, drafts, publication pointers and history remain unchanged. |
| H9 | Primary and secondary identities differ; valid foreign keys and other database integrity rules remain enforced. |
| H10 | Authorization, revision checks, private notes, consent and publication protections remain enforced. |

Hard rules never become weighted penalties. A partial result relaxes coverage
and target *fulfillment*, not availability, target ceilings or other invariants.

### 10.1 Consecutive blocks

For the same engineer, intervals that meet at a handover are consecutive.
Forbidden automatic sequences include Monday → Tuesday, Thursday → combined
Friday–Saturday, combined weekend → Sunday, and adjoining last/first duties
across an owner-month boundary.

A combined weekend is one block; Friday → Saturday inside that block is not
two assignments. Split Friday and Saturday are separate blocks and cannot both
be assigned automatically to the same engineer. Special weekend daily blocks
follow the same rule. Explicit fixed-pair manager approval is the only permitted
consecutive exception.

### 10.2 Weekend capacity and small teams

Count distinct Friday weekend identities among primary assignments owned by the
month. Either half consumes that weekend; emergency assignments consume none.
The cap is not a count of daily weekend rows.

With two engineers and five ordinary combined weekends, at most two distinct
weekends can be automatically covered; the other three remain open unless
explicit manager intervention resolves them. Weekday alternation/spacing still
applies. The solver does not split or waive the cap to achieve full coverage.

### 10.3 Fixed neighboring assignments

Read the previous owner's assignments and any existing next owner's assignments,
including actual intervals extending across a calendar boundary.
Current live publications bind. Relevant existing working assignments also
bind while that neighboring draft exists.

Engineering policy: use the union of current published and working primary
commitments as conservative boundary guards, deduplicated by owner, interval
and primary identity. Do not let the ordinary manager snapshot projection hide
the live publication merely because its neighbor has been reopened. Historical
non-current versions do not bind.

For adjacency, protect against each binding interval. For spacing, each
engineer's nearest preceding and nearest following binding interval are enough;
retain source labels so a draft-only restriction can be explained. A manager
may deliberately change/cancel the neighbor's draft through its normal workflow;
current generation cannot do so.

This policy can produce a partial schedule when a reopened draft conflicts with
its live version. Show that source conflict rather than pretend both are one
new definitive assignment. No neighboring working draft is projected as actual
compensation repayment; only published commitments are.

### 10.4 Emergency assignments

Preserve all emergency/secondary assignments on their duties. They earn zero
regular points, create no primary compensation, do not enter spacing or
consecutiveness and consume no primary weekend allowance.

Preserving identity integrity is a separate candidate check:
`automatic primary(d) != existing secondary(d)`.
This resolves the old specification's apparent contradiction. Exclusion from
primary workload calculations does not exempt a secondary's identity from the
database's same-person prohibition.

Existing secondary membership/availability checks at publication remain.
If preserved emergency coverage prevents publication, show it for separate
manager resolution; the solver must not remove it or use it as another primary
workload assignment.

## 11. Objective hierarchy: complete and partial results

Use one optional-coverage model with a lexicographic objective vector.
At no stage can a lower-priority objective degrade a proved higher objective.
No arbitrary weighted sum of calendar coverage, points and spacing is allowed.

| Priority | Objective | Exact meaning |
|---:|---|---|
| 1 | Maximum calendar-day coverage | Maximize the number of owned covered dates. Combined weekends count 2; single daily blocks count 1. |
| 2 | Special/holiday coverage | At the same date coverage, maximize covered dates explicitly marked special/holiday. |
| 3 | Minimum missing target points | At the same first two values, minimize total unmet primary points. Never exceed an individual's target. |
| 4a | Maximum minimum spacing | Maximize the shortest applicable end-to-start gap for any engineer. |
| 5 | Weekend rotation across months | At the proved minimum gap, give this month's weekends to the members with the fewest weekend turns in the current rotation cycle (section 11.3): minimize the sum of the turn counts of the members who receive a weekend. |
| 6 | Weekday variety | Minimize same-weekday repeats: for each member and Sunday–Thursday weekday, every duty beyond the first on that weekday counts one. Weekend halves never count. |
| 7 | Overall gap distribution | Improve the remaining smallest gaps in order (the full sorted-gap leximin), preventing a fixed close pair from making all spacing decisions irrelevant. |
| 8 | Preferred dates | Prefer available “preferred” dates among equal higher outcomes. |
| 9 | Seed | Seeded alternatives among schedules equal on every level above. |

*Decision 2026-10-31 (revised the same day):* the rotation and weekday levels
sit directly below the proved minimum gap and above the remaining gap
distribution, because the owner wants both rules to hold with rare exceptions
only. Below the full spacing vector they were nearly inert: with at most four
Sunday–Thursday duties per member, two schedules with the same sorted gap vector
always have the same repeat count (checked exhaustively for November 2026), and
on an ordinary twelve-engineer month the spacing optimum places most pairs
exactly two weeks apart, which is the same weekday; a one-day refinement of a
non-minimal gap could also override "everyone gets a weekend before anyone gets a
second". Measured on the ordinary fixture, the move keeps the minimum gap and
removes every repeat: the sorted gap vector goes from `[11,11,12,12,13×9,14]` to
`[11,11,12,12,12×5,14,14,14,14,15]` days. Rotation outranks weekday variety
because it is a cross-month fairness commitment with memory. The order below the
minimum gap is fixed in one place, the `early`/`late` stage lists in
`lib/scheduling/solver/model.ts`.

Required special/holiday input comes from configured Special Blocks/explicit
existing calendar markers. Do not infer importance from extra-point magnitude
or introduce a paid/new holiday service. All marked dates have equal priority
at this stage unless a later product decision introduces explicit ranks.

Priority 3 equals maximizing covered point weight **only after** priorities 1
and 2: `sum(missing units) = P − assigned units`.
Thus a two-date ordinary combined weekend can beat a one-date high-point
special when both cannot be covered. This is an intended consequence of maximum
operational coverage, not a bug to “correct” by maximizing points first.

When all dates are covered, priorities 1–3 force exact targets and the hierarchy
reduces to max-min spacing, overall spacing and high-quality alternatives.
When the result is partial, target shortfall distribution can be unequal.
Do not silently add an extra per-engineer deficit-balancing policy ahead of the
confirmed priorities; always display every person's actual shortfall.

### 11.1 Spacing metric and pair set

Sort each engineer's selected-month primary intervals, including locks.
Include the nearest binding interval before and after the owned coverage range
when present. Measure the elapsed minutes from one duty's actual end to the
next duty's actual start. Touching duties have zero free minutes.

Score successive pairs with at least one selected-month duty. Ignore a pair
entirely outside the month. An engineer with fewer than two applicable
intervals contributes no gap; no gap is created for an unassigned duty.

The primary gap objective is the minimum of these values, not their average.
Locked fixed-pair exceptions remain in the measured list. A zero gap fixed by
manager choice cannot be improved, but it must not be erased to claim a higher
global minimum.

For the secondary objective, lexicographically maximize the sorted ascending
gap vector; this improves the next-worst gap after an unavoidable fixed minimum.
Compare variable-length vectors padded with positive infinity for missing
pairs; an empty pair set has a vacuous infinite minimum. Higher coverage and
point objectives are fixed first, so this convention cannot reward leaving an
otherwise coverable duty empty.

Use a chronological successor-arc model or an equivalent verified method for
successive-pair gaps. Finite precomputed gap thresholds/counts can implement
leximin through repeated linear solves. Do not use a single average/sum that
allows one very close pair to hide behind distant duties.

### 11.2 Reproducible alternatives

Generate draws a fresh cryptographic seed for each confirmed run. Stable input
ordering plus the recorded seed, core/model version, solver version/settings
and source snapshot support reproducibility under an equivalent environment.
Time-limited searches may also need deterministic work/node budgets for exact
replay; a wall-clock timeout alone is not reproducible.

At the final equal-quality stage, use seeded tie-break ordering or a seeded
last-stage objective. A no-good constraint may exclude the previous arrangement
only after retaining all proved higher objective values; if no equal-quality
alternative exists, retain a valid arrangement. Previous unlocked assignments
are not fixed, favored or imported as mandatory constraints.

Never promise a different answer for a unique result or sacrifice higher
coverage, special coverage, fulfilled points or spacing merely for variety.
Randomness does not mutate compensation or targets.

The seed objective is a random linear cost over every assignment variable, so
every schedule that is equal on all higher levels is reachable by some seed
(each 0/1 point is an extreme point of their convex hull). Variety is therefore
bounded only by how many such equal schedules exist: with twelve engineers and
two or three duties each, the spacing vector pins the date pattern and the seed
mostly permutes interchangeable members; availability constraints and preferred
dates break that symmetry and can leave a unique optimum, which the seed cannot
and must not change.

### 11.3 Weekend rotation state

Rotation state is derived from the current publications of all other months,
in chronological order, with no new table (`lib/scheduling/rotation.ts`).
For each month, a member who is primary on any Friday or Saturday duty owned by
that month takes one **turn** (either half of a split weekend counts; both halves
in one month are still one turn), and a member with any primary duty is
**present**. Turn counts accumulate per member. Once every member present in
the current cycle has at least one turn, the cycle completes: every count drops
by one (an exception's second turn carries over) and presence resets. The
objective weight of a member is their count, except that a member not present in
any month of the current cycle counts as one while the cycle is in progress
(someone present already has a turn) and as zero otherwise: new or returning
members join the next cycle level with the team, never due first. A skipped
member keeps count zero and remains due in later months. Locked weekend duties
count through the same weight. Secondary cover, working drafts and the month
being generated are ignored. The state is a soft objective only: the checked
database save does not revalidate it.

## 12. Validation, result states and proof

### 12.1 Fast checks

Check exact totals, valid denominations, nonnegative targets, lock floors,
canonical ownership/coverage and essential identities immediately.
These structural failures block a run.

Also compute cheap warnings for missing candidates, a fully unavailable engineer,
insufficient weighted/shared capacity, unreachable target combinations,
consecutive-only opportunities and weekend shortages. These warn about possible
or proved **complete** infeasibility; they do not disable partial generation.
A low availability count is not itself an error.

### 12.2 Global optimization

Evaluate all engineers together against shared duties, exact weights, locks,
availability, identity exclusions, consecutive conflicts, weekend caps and both
boundaries. Individual feasibility does not imply global feasibility.

The coverage solve can establish complete feasibility or prove its absence.
Once all structural checks pass, “all unlocked duties unassigned, locks retained”
is a valid partial incumbent. If the optional-coverage model reports infeasible
even then, investigate inconsistent mandatory inputs/model construction; do not
mislabel ordinary target infeasibility as a reason no partial model exists.

### 12.3 State model

Keep result completeness, search status and objective proof separate internally:

| State/fact | Meaning and action |
|---|---|
| V1 generation window closed | Coverage has started; disable/reject Generate/Regenerate and discard any late result. Keep accepted data and manual-change/swap workflows; this is not a solver infeasibility result. |
| Structurally invalid | No run/save until repaired; specific inline explanation. |
| Checking / running | Current input being validated/optimized; responsive UI, Cancel available. |
| Complete feasible | Verified full coverage and exact targets; spacing may still be unproved optimal. |
| Complete infeasible, proved | No full assignment exists under these inputs; allow partial generation. |
| Verified partial | Valid assignments, preserved locks, no target exceeded; shortfalls/uncovered dates shown. It need not be the optimal partial result. |
| Proven optimal partial | A verified partial result with all required higher quality/spacing stages proved. If only a prefix is proved, report that narrower fact, e.g. “Maximum coverage proved; spacing search limited,” rather than claiming the whole result optimal. |
| Timeout / UNKNOWN with incumbent | Save/present the independently verified best found result, complete or partial, with no false optimality claim. |
| UNKNOWN without a verified incumbent / runtime failure | No replacement of the accepted draft; explain/retry. It is not proof of impossibility. |
| Cancelled / stale | Discard result; keep accepted data. Never apply to changed inputs. |

Store the objective vector, proved prefix and termination reason. If stage 1
times out, retain its best incumbent and do not optimize a later objective at the
expense of searching for better calendar coverage. Only fix a stage's value for
lower-stage optimization once its optimum is established.

After solving, use a pure independent integer validator to recompute assignments,
coverage, all target deficits and every hard rule. MILP tolerances never
authorize a wrong half-point result. Structural validation and this result
validator must also be enforced at the future checked save boundary.

### 12.4 Grounded explanations

Explain demonstrated constraints using people, dates, points, locks and source
months. Do not promise a unique minimal root cause for every infeasible model.
Timeout is “not established within the search limit,” never “impossible.”
Distinguish a proven shortage from a plausible contributing restriction.

All allocation warnings and details stay inline. The calendar marks uncovered
dates, while the retained table shows requested, assigned and missing points.
Saving a partial draft is supported; publishing it remains blocked by the
existing full-coverage and integrity checks until the manager resolves it.

## 13. Conflict cases and expected manager explanations

| Case | Detection and required outcome |
|---|---|
| Entire month unavailable, positive target | Show the engineer's unmet target. Produce valid work for others; never exceed or silently zero that target. |
| Nobody available on one duty | Mark its covered date(s) unassigned. Manager can deliberately assign/lock an override. |
| Two engineers each have three distinct usable opportunities for three points | Scarcity alone is not failure. Preserve their opportunities in the global search. |
| Two engineers need six points from the same three one-point duties | Explain the proven shared-capacity shortage and produce the best partial result. |
| Available dates are all consecutive | Respect adjacency, leave necessary holes and show unmet points. |
| Availability allows enough points but only through extra weekends | Enforce the cap, identify the blocked weekends and leave them uncovered. |
| Only a four-point duty is usable for a three-point target | Do not assign it; retain unmet points and consider other engineers without changing any target. |
| A lock consumes another engineer's only slot | Keep the lock and show the resulting shortfall; a valid lock is not removed to improve coverage. |
| Lock exceeds target or has an unauthorized fixed conflict | Structural error; repair the allocation/approval before running. |
| Previous or next assignment blocks an adjacent duty | Name the engineer, dates and owning published/draft source; do not edit it. |
| Preserved emergency identity excludes the only primary candidate | Explain the identity restriction; no duplicate role or automatic secondary deletion. |

Shared-capacity example:

> Daniel and Noam need 6 points together, but their available dates contain only
> 3 points of duty capacity. Generate can create a partial schedule.

Assume 5, 12 and 19 November are the same three ordinary one-point duties and
both need 3. At most 3 points can be assigned between them. This simple capacity
message is appropriate only when supported by those actual facts. More complex
overlapping sets, weekend or adjacency restrictions may need several contributing
facts rather than a fabricated single cause.

Manager resolutions remain inside the existing workflow: adjust targets,
deliberately classify a permanent transfer, change/lock/unlock a duty, or run again.
An infeasibility explanation is not an automatic authorization to violate it.

## 14. Mathematical formulation and implementation architecture

### 14.1 One optional-coverage model

Let `E` be active approved eligible engineers and `D` the selected owner's
canonical duties. Parameters are integer units `q[d]`, confirmed `t[e]`,
covered-date counts `c[d]`, marked special-date counts `h[d]`, actual intervals,
weekend IDs, locks, scoped exceptions and fixed neighboring context.

The V1 fresh-whole-month formulation applies only before owner-month coverage
starts. The time gate in section 15.4 is checked outside the solver; started or
completed selected-month duties never become its decision variables.

Use binary variables:

`x[e,d] = 1` if engineer e is primary on duty d.

`u[d] = 1` if duty d remains unassigned.

Exclude automatic combinations that fail eligibility, availability,
primary/secondary identity or a fixed boundary restriction. A valid manager
availability lock is fixed authorized input, not an excluded automatic edge.

| Rule | Constraint |
|---|---|
| One primary or explicit hole | `sum_e(x[e,d]) + u[d] = 1` for each d. |
| Target ceiling | `a[e] = sum_d(q[d] × x[e,d]) <= t[e]`. |
| Visible shortfall | Integer `m[e] = t[e] − a[e] >= 0`. |
| Valid lock e on d | `x[e,d] = 1`, hence `u[d] = 0`. |
| Forbidden consecutive pair a,b | `x[e,a] + x[e,b] <= 1`, except the specifically approved fixed pair. |
| Fixed neighboring conflict | Exclude/fix to zero the conflicting automatic variable. |
| Weekend usage | Binary `y[e,w]` is the OR of primary assignments with Friday identity w. |
| Ordinary weekend limit | `sum_w(y[e,w]) <= 1`. With additional approved locked weekends, constrain usage to those specific fixed weekend identities. |
| Month isolation | Neighbor assignments are constants, not writable variables or selected-month point totals. |

An exact OR can use `y[e,w] >= x[e,d]` for each relevant d and
`y[e,w] <= sum_d_in_w(x[e,d])`.
Do not count split rows as separate weekends.

Structural validation precedes the model. In particular, an approved fixed
consecutive pair is not wrongly rejected by a blanket pair constraint, and an
unapproved pair is not silently allowed just because both assignments are locks.

An equivalent implementation can remove locked duties from free variables and
use remaining capacity `t[e] − l[e]`; do not count locks twice.
The all-unlocked-unassigned solution is the safe initial partial incumbent.

### 14.2 Lexicographic solve

In order, maximize/minimize:

1. `C = sum_d(c[d] × (1 − u[d]))`.
2. `H = sum_d(h[d] × (1 − u[d]))`, fixing optimal C.
3. `U = sum_e(m[e])`, fixing optimal C and H.
4. The maximum minimum gap from section 11 (threshold search), fixing C, H and U.
5. Weekend rotation cost `sum_e(turns[e] × sum_w y[e,w])`, then same-weekday
   repeats `sum_{e,wd} r[e,wd]` with continuous `r[e,wd] >= sum_{d on wd} x[e,d] − 1`,
   each fixed once proved, with the minimum gap enforced by the successor flows.
6. The sorted-gap leximin counts, then the preferred-date count, each fixed once proved.
7. The seeded tie-break objective, fixing all higher quality.

All coverage/point objectives have exact integer values. Use repeated solves
with constraints fixing the proved previous objective values. Set integrality
and optimality tolerances so an “optimal” status cannot knowingly leave an
integer objective value improvable. Independently verify objective values and
the solver's termination/bound evidence; a relative gap setting alone is not
permission to claim exact lexicographic optimality.

With `C = sum_d(c[d])`, all `u[d] = 0`; then
`sum_e(a[e]) = P = sum_e(t[e])` and `a[e] <= t[e]` prove every
`a[e] = t[e]`. This is why the partial upper-bound formulation also correctly
implements exact complete targets without contradictory soft equalities.

### 14.3 Spacing encoding

Optimize coverage/points with assignment variables alone. Once their optima are
proved, binary-search the finite attainable end-to-start gaps, plus infinity.
For threshold g, forbid a same-engineer pair i,j when `start[j] - end[i] < g`:
`x[e,i] + x[e,j] <= 1`. A fixed boundary reduces this to an exclusion of x.
All-pair conflicts implement the minimum exactly: a non-successor gap cannot
be shorter than every successor it spans. Never compare two external anchors.
A verified witness proves feasibility; only an infeasible termination proves
infeasibility. UNKNOWN retains an interval and stops lower-priority refinement.
Implement the pair restrictions with maximal cliques of expanded intervals
`[start, end + g)`, plus boundary exclusions. For chronological nonoverlapping
duties, a sliding window produces at most O(ED) clique rows with O(ED²)
nonzeros. Their LP relaxation is stronger than separate pair inequalities.
Fixed intervals give an upper bound because inserting duties cannot increase
their minimum gap. In particular an approved locked zero needs no threshold
search, but remains part of the measured objective.

After proving the minimum, add pruned chronological successor paths, with arcs
below that minimum removed. Remove arcs jumping a mandatory lock or exceeding
target capacity with the other locks. Incoming/outgoing flow equals x; one
source-to-sink unit and acyclic order prevent disconnected paths or skipped
selected nodes. These flow variables are **continuous in [0,1]**: binary x
requires every selected node to carry the full unit, forcing the unique path
through all selected nodes in chronological order. Weekend OR variables also
need no independent integrality. An empty path contributes no measured gap.

Minimize successor-gap counts at ascending finite gap values, fixing each proved
optimum. A verified zero count is optimal by nonnegativity and its arcs can be
fixed to zero without another solve. This is exactly the sorted-gap comparison,
including infinity padding for partial/empty paths. All-pair distance penalties
would change that objective. Mandatory locked gaps are retained; later counts
still improve after an unavoidable zero. Reuse one native model per request,
change costs/rows/bounds, and resubmit only independently verified assignments
compatible with the current constraints. Do not assume MIP tree reuse.

An optional weighted-interval dynamic program supplies valid per-engineer point
capacity cuts with and without a weekend. If those maxima are A and B, add
`assignedUnits <= A + (B - A) * sum(weekendUsage)`, using the ordinary one-weekend
cap. Impossible modes are excluded explicitly. The DP includes locks, boundary
anchors, hard adjacency, the trial minimum gap and exact point ceilings. This
captures half-weekend/whole-point incompatibilities that otherwise cause costly
fractional relaxations. It selects no assignments and changes no priorities.
The spike omits this optional cut for targets above 4,096 units and approved
multi-weekend exceptions; the original constraints still enforce correctness.
For bounded target Q and W weekend identities the DP takes at most O(D² W Q)
state transitions per engineer and O(D W Q) stored states.

For E engineers, D duties and T distinct gap values, the assignment model has
O(ED) binary variables. Minimum-gap search takes O(log T) feasibility calls with
O(ED) clique rows and up to O(ED²) nonzeros. Refinement adds at most O(ED²) continuous columns and
O(ED) path rows, with at most O(T) count stages (many require no solve). These
are size/call bounds, not a polynomial runtime or five-second guarantee.

This is an engineering formulation recommendation. Equivalent encodings are
acceptable only if tests against enumerable small instances show the same
business objective ordering, including variable duty counts and fixed exceptions.

### 14.4 Layer boundaries

| Layer | Responsibility |
|---|---|
| Pure domain core | Canonical owned duties, exact units, locks, validation, baseline, typed transfer intents, deterministic normalization/replay and result verification. No React, network, storage, wall-clock reads or random source calls inside pure functions. |
| Solver adapter | Build/solve the declared model, return incumbent, objective vector, proof prefix and termination data. No target edits or ledger writes. |
| Browser Worker | Isolate computation, consume serializable frozen inputs/settings/seed, return progress/results associated with a request ID. |
| React/UI | Allocation controls, explicit confirmation, actual/projected explanatory copy, progress/cancel, partial calendar and unmet points. |
| Supabase adapter | Read authoritative snapshots, reconcile through checked operations, save owner-scoped drafts/publication metadata under revision control. |
| Database | Validate permissions, identities, source keys, exact ledger effects, integrity, locking and atomic publication/ledger transitions. |

Use explicit input `now` and seed values in domain APIs for deterministic tests.
One generation context combines current publication and relevant working
boundary facts; do not overload the existing role-specific display snapshot to
silently choose a different accounting source.

### 14.5 Solver assessment and recommendation

Recommend a MILP adapter with local single-threaded WebAssembly in a dedicated
Worker as the first implementation spike. The current TypeScript model is small
enough to assess this direction before considering a new service. This is not
approval to install a dependency or a claim of measured performance.

[HiGHS upstream](https://github.com/ERGO-Code/HiGHS) supports MIP and documents
its build/licensing distinctions. The
[lovasoa/highs-js wrapper](https://github.com/lovasoa/highs-js) documents browser
WebAssembly, TypeScript declarations, persistent models and synchronous,
single-threaded solves. These primary sources were reviewed on 23 October 2026;
they establish a plausible candidate, not validated Next.js/iPhone compatibility.

| Assessment | Required implementation gate |
|---|---|
| TypeScript/Next.js App Router | Verify actual pinned wrapper exports/types, production bundling and client-only loading. No solver import/initialization during server rendering. |
| Assets/deployment | Self-host pinned WASM with correct URL/MIME/cache behavior and repository deployment policy; avoid an external CDN dependency. |
| Browser/iPhone Safari | Test actual supported phones, memory growth, Worker/WASM initialization, repeated solves, cancellation and background/resume behavior. |
| Maintenance | Inspect the selected release, issues, upstream solver version and reproducible artifact provenance; documentation alone is insufficient. |
| License | Verify the exact wrapper and embedded build/third-party notices. Do not assume every optional HiGHS build has identical licensing. |
| Correctness | Preserve integrality and status/bound information. Do not accidentally run an LP relaxation instead of MIP. |
| Resources | Dispose persistent native/WASM models; benchmark cold/warm load and repeated allocation checks. |
| Configuration | Pin settings/version; record seed mapping, tolerances and deterministic work limits for replay. |

HiGHS documents time, random-seed and MIP-gap options in its
[official option reference](https://ergo-code.github.io/HiGHS/dev/options/definitions/).
Use the selected adapter's verified supported controls rather than guessing API
names. Sequential objective solves avoid reliance on unverified wrapper support
for native multiobjective features.

Tradeoff: browser WASM avoids service operation and sends no scheduling data to
a solver provider, but startup/memory and interruption need device validation.
A custom branch-and-bound solver increases maintenance/proof burden; a new
backend adds deployment/auth/data boundaries. Neither is justified merely
because the existing heuristic is inadequate. A demonstrated technical need
and manager approval are required for a new backend/paid service or AI inference.

### 14.5.1 Isolated HiGHS compatibility spike (23 October 2026)

Historical baseline at `22f6d0e3a5595b76538fbe9348cc3126822e4f1b`.
Section 14.5.2 records the revised implementation and current assessment.

Scope: `lib/solver-spike/`, its Node benchmark/tests and an opt-in production-build
browser harness. Nothing imports this adapter from the existing Generate flow.
There are no compensation, persistence, migration or product UI changes.

**Assessment: suitable to continue evaluating for local feasibility and coverage
optimization; not yet approved as the production scheduling solution.** Normal
12-engineer coverage/point solves are fast on the measured desktop. The initial
successor-arc spacing formulation substantially increases cost and does not
prove the full gap ordering within a five-second search budget. Real iPhone
Safari, production deployment and full domain integration remain gates.

Package and compatibility evidence:

- Exact dependency `highs@1.15.4`, zero runtime package dependencies. The loaded
  binary reports HiGHS **1.15.1**, git hash `04024d7`; package and native patch
  versions are recorded separately. Registry integrity is pinned in the lockfile.
- TypeScript 5.9.3 and Next.js 16.3.4 production compilation pass. Directly
  bundling the upstream ESM loader fails in Turbopack: it interprets the WASM's
  native import module `a` as a JavaScript dependency. The bounded workaround
  serves the unchanged package loader and WASM on the same origin, with explicit
  asset URLs and file tracing. Next still compiles the adapter and Worker.
- `/solver-spike` has no visible controls and returns 404 unless the server has
  `DUTY_SOLVER_SPIKE=1`. The allowlisted asset route has the same gate, correct
  JavaScript/WASM MIME types and `Cache-Control: no-store`. Production Generate
  does not load these assets. Existing browser-test server launchers alone opt in.
  Long-lived immutable caching is deliberately deferred until production adoption.
- No CDN, solver provider, SharedArrayBuffer or cross-origin isolation is used.
  Node and Chromium execute the same adapter. This wrapper is single-threaded;
  its extended API explicitly rejects the `threads` option.
- Native models are disposed in `finally`, including parser failures. A reusable
  Worker supports sequential warm runs; its owner must explicitly terminate it.
  Cancellation terminates the Worker, rejects pending work and rejects reuse;
  a new Worker can solve again. Request IDs reject stale responses. A main-thread
  watchdog also bounds failed initialization/unresponsive requests.

The synthetic normalized model tests binary assignments, availability candidate
edges, fixed locks, exact integer half-point ceilings, distinct weekend identities,
nonconsecutive primaries and optional holes. Full coverage plus balanced totals
implies each exact target. Independent assignment validation recomputes coverage,
special coverage, units, deficits, caps and actual successive gaps without the LP.
Tiny exhaustive enumeration checks the three coverage/point priorities and
leximin gaps, including variable-length paths padded with infinity. Only native
binary endpoint noise within `1e-8` is normalized; fractional values such as 0.5
are rejected, then every domain rule is checked with exact integer assignments.

Stages solve separately, fixing earlier objectives only after optimal status,
zero MIP gap and an integer bound excluding any better integer value. Results
separate completeness, proved prefix and termination/bound/node information.
UNKNOWN/limited solves retain a verified incumbent, including the initial locked
partial assignment; no lower stage runs after an unproved stage. The budget is
shared across stages, with remaining wall time and node count passed onward.
Model parsing/validation can add overhead beyond the nominal solver time limit;
Worker termination is the hard cancellation mechanism.

Historical reproduction at the baseline commit, from the repository root
(Node 24.19.0, pinned pnpm). Current comparison commands are in section 14.5.2:

```sh
node --test tests/highs-spike.test.mjs
node scripts/benchmark-highs.mjs
pnpm exec tsc --noEmit
pnpm build
pnpm test:e2e:ci solver-spike.spec.ts
```

Preliminary workstation measurements: Windows x64, Intel Core i9-10900KF
3.70 GHz, Node 24.19.0; three runs per fixture in one WASM instance, seed 17,
10,000 total nodes and five seconds per request. Times include model construction,
LP parsing, all attempted stages and independent validation; initialization is
separate. These synthetic cases are performance probes, not release budgets.

| Fixture | Engineers / duties | Covered dates | Total milliseconds (three runs) | Proof / linear-memory high water |
|---|---|---|---|---|
| Ordinary combined weekends | 12 / 26 | 30 / 30 | 201, 69, 59 | All three stages; 20.25 MiB |
| Tight availability, weighted specials, no candidates on one date | 12 / 26 | 28 / 30 | 58, 28, 29 | Optimal partial for three stages; 20.25 MiB |
| Split weekends and two locks | 12 / 30 | 26 / 30 | 147, 119, 124 | Optimal partial for three stages; 20.25 MiB |
| Weekend-cap shortage | 2 / 26 | 26 / 30 | 26, 27, 26 | Optimal partial for three stages; 20.25 MiB |
| Larger team | 24 / 26 | 30 / 30 | 133, 135, 136 | All three stages; 20.25 MiB |
| Successor-gap spacing | 12 / 26 | 30 / 30 | 5,067, 5,076, 5,041 | Coverage/points proved; spacing incomplete; 72.88 MiB |

The ordinary model has 361 columns/446 base rows; spacing has 4,597 columns/
1,094 base rows, before fixed-objective rows. WASM initialization in this Node
sample is about 28 ms. Warm linear memory remains at its high-water allocation:
`dispose()` frees native model ownership but does not shrink WASM memory.
Three spacing requests reuse that high water with zero live adapter models after
each request. This is bounded observed allocation, not proof that every native
allocation is leak-free or that the browser immediately returns RAM to the OS.

Desktop/mobile Chromium viewport checks run in the pinned Playwright container
against the actual Next production build. They verify WASM bytes against the
installed package, warm deterministic assignments, eight repeated memory samples,
main-thread cancellation during a synchronous solve, rejection after termination
and a fresh Worker restart. JSON timings are attached to the Playwright report.
In the final focused run (two browser workers), ordinary cold/warm request times
were 438/126 ms at the desktop viewport and 407/121 ms at the mobile viewport;
WASM initialization was 150/140 ms respectively. All eight repeated ordinary
memory samples remained 20.25 MiB. Constrained/split requests took 199–437 ms;
spacing requests stopped at about 5.0–5.1 seconds with only a higher-objective
proof prefix. These are desktop Chromium measurements at two viewport sizes.
Viewport emulation does **not** establish iPhone Safari compatibility, background/
resume behavior, device memory pressure or touch responsiveness.

Known limits before adoption: synthetic caller-supplied chronological minute
intervals/candidate edges, no Jerusalem calendar normalization, boundary anchors,
secondary-identity adapter, scoped manager exceptions, seeded final tie objective,
compensation or checked save integration. These are deliberately outside this
spike. Identical completed runs reproduce assignments in the tested environment;
wall-clock-limited incumbents are not promised reproducible. Benchmark boundary
anchors and improve spacing formulation/stage reuse before setting a release UX
budget. No production/mobile compatibility claim follows from these results.

Artifact audit: the package's MIT license is retained and served alongside the
assets. The [tagged build recipe](https://github.com/lovasoa/highs-js/blob/v1.15.4/build.sh)
uses single-threaded Emscripten, growing memory, 32-bit HiGHS integers and disables
zlib. The [1.15.4 release](https://github.com/lovasoa/highs-js/releases/tag/v1.15.4)
fixes submitted MIP callback solutions; this spike does not use that callback.
The [open issue list](https://github.com/lovasoa/highs-js/issues) was checked;
the listed C API expansion request is not a blocker for this adapter. The npm
release includes a provenance attestation, but this spike does not independently
rebuild or verify that attestation; complete binary/third-party notice provenance
review remains a production adoption gate. Exact installed SHA-256 identities:

```text
highs.mjs   f2bdfd071d19c3745756a087026589e9240f329e38315a86f626823ae78a4036
highs.wasm  f13134e3e335e7bad984ff12abeb41e86e0eeeb1752ae8a85322cc6839df8acd
LICENSE     9f8d8dcf27789ac59c0d7c732d6682f148804a5e99d83e9f207d6c1882b98bfa
```

### 14.5.2 Threshold search and continuous-flow follow-up (24 October 2026)

**Assessment: ready to begin controlled Generate implementation using this
adapter, subject to the remaining domain/integration and real-device gates.
This isolated spike is not approval to ship the redesigned Generate.**

The follow-up implements section 14.3: coverage/points without successor
variables; exact discrete minimum-gap feasibility search; pruned continuous
successor flows for full leximin; and one native model per request. It uses
maximal interval cliques and optional exact per-engineer capacity cuts. The
capacity cuts matter for partial split weekends: an odd half-weekend allocation
cannot fill an even ordinary target. Smaller models alone were insufficient.
The intermediate clique-only split case still exhausted 30 seconds and grew to
217.81 MiB; the final capacity cuts reduced its high-water to 87.50 MiB and
allowed full proof. These diagnostic runs motivated the retained formulation.

Native rows, costs and bounds are changed through the pinned wrapper API.
Only independently verified assignment binaries are resubmitted as sparse MIP
starts; HiGHS completes continuous variables. No invalid start is submitted to
a stricter threshold. Native clocks are reset for each run and the remaining
request time/node budget is shared across stages. Native models are disposed
in `finally`. Reuse does not imply retention of the branch-and-bound tree.
Full coverage makes the special/point stages algebraic identities. Verified
zero gap-count stages likewise need no native solve. Proof records distinguish
these identities from native status/bound evidence. UNKNOWN never establishes
infeasibility; an unfinished threshold search reports its feasible lower bound
and first excluded upper threshold (null denotes infinity), without claiming
minimum-gap or leximin optimality.

The normalized input now accepts all binding boundary commitments, source labels
and exact fixed-pair/boundary/weekend exception scopes. Hard conflicts check
every boundary; spacing uses the nearest preceding end and following start.
An empty path creates no anchor-to-anchor gap. Locks, including approved zero
gaps, remain measured and mandatory. An approved extra-weekend list must match
the engineer's locked weekend identities; it cannot authorize another weekend.
Boundary points never enter selected-month targets. Caller-supplied elapsed
minutes support DST and Friday-owned cross-year intervals; construction of
those inputs from the actual calendar/database remains future integration.

The independent test oracle enumerates tiny schedules without calling the
model or domain validator. Cases include weighted partial schedules, different
gap-vector lengths, empty paths, published/draft boundary unions, exact-minute
DST intervals, Friday-owned cross-year coverage, fixed zero gaps, scoped
exceptions, lock/capacity arc pruning and omission of optional cuts for large
targets. Twenty-four additional small varied instances check objective ordering.
Focused tests also cover UNKNOWN/timeout incumbents, model disposal, verified
starts and progress snapshots. Generate and its storage/UI paths are unchanged.

Local validation passed: 12 focused solver tests, TypeScript, affected-file
ESLint, the Next production build/CSS check, and four Docker Chromium Worker
checks across desktop/mobile viewports. Browser checks include serialized
boundary/exception inputs, progress, repeated memory, cancellation during a
synchronous solve, termination and restart. There were no changed visual
references. These checks establish neither real iPhone behavior nor CI success.

Measurements below use the same workstation as section 14.5.1: Windows x64,
i9-10900KF, Node 24.19.0, wrapper 1.15.4/native 1.15.1, seed 17, **1,000,000 total
nodes** and either 5 or 30 seconds per request. Each engine/fixture/budget uses
a fresh sequential child process/WASM instance with three warm-capable repeats;
initialization is excluded from request times. No build or browser check ran
concurrently with the final timing runs. The old implementation is loaded
unchanged from the baseline commit. Common inputs have matching SHA-256 hashes;
the original cannot correctly represent boundaries or scoped exceptions, so
those rows deliberately have no old comparison. See the
[60 recorded runs](benchmarks/highs-spacing-2026-10-24.jsonl) for exact gaps,
deficits, proof prefixes, sizes, memory and settings.

Seconds below are medians, with the three-run range in parentheses. "Full proof"
means every requested spacing stage, except the explicitly coverage-only row.

| Fixture / request budget | Old seconds | New seconds | Proof and spacing result |
|---|---:|---:|---|
| Coverage/points only / 5 s | 0.066 (0.062–0.230) | 0.040 (0.026–0.117) | Both prove coverage/points; 30/30 dates. |
| Ordinary spacing / 5 s | 5.045 (5.038–5.072) | 1.681 (1.629–1.984) | Old minimum 2 days, unproved; new full proof, minimum 11 days. |
| Ordinary spacing / 30 s | 20.361 (19.513–21.086) | 1.788 (1.775–2.237) | Both prove the same full gap vector; about 11.4× faster. |
| Weighted partial spacing / 5 s | 2.409 (2.384–2.913) | 0.241 (0.228–0.455) | Both prove the same vector; 28/30 dates, minimum 8 days. |
| Weighted partial spacing / 30 s | 2.502 (2.464–2.855) | 0.263 (0.240–0.456) | Both prove the same vector; about 9.5× faster. |
| Split weekends + locks / 5 s | 5.104 (5.103–5.118) | 5.013 (5.010–5.019) | Both cover 26/30; old assigns 47 units, new 48 with coverage/points and 9-day minimum proved. New leximin remains unproved. |
| Split weekends + locks / 30 s | 30.057 (30.056–30.070) | 28.656 (27.597–28.958) | Old leximin remains unproved; new full proof in all three runs. |
| Boundary union / 5 s | Unsupported | 2.066 (1.972–2.353) | Full proof; 30/30 dates, minimum 8 days. |
| Boundary union / 30 s | Unsupported | 2.062 (2.036–2.380) | Same proved optimum. |
| Locked zero / 5 s | Unsupported | 3.164 (3.137–3.579) | Full proof; mandatory zero retained, next-smallest gaps improve to 11 days. |
| Locked zero / 30 s | Unsupported | 3.110 (3.039–3.499) | Same proved optimum. |

| Spacing fixture | Old total / binary columns | New base / total / binary columns | Old / new WASM MiB at 30 s |
|---|---:|---:|---:|
| Ordinary | 4,597 / 4,597 | 361 / 2,533 / 313 | 87.50 / 60.69 |
| Weighted partial | 795 / 795 | 124 / 533 / 110 | 50.56 / 20.25 |
| Split weekends + locks | 6,013 / 6,013 | 409 / 3,095 / 361 | 105.00 / 87.50 |
| Boundary union | Unsupported | 361 / 2,972 / 313 | Unsupported / 60.69 |
| Locked zero | Unsupported | 361 / 3,733 / 313 | Unsupported / 42.13 |

Binary totals include one fixed diagnostic binary. Ordinary spacing falls from
31 native model creations to one; the revised request submits verified starts
and skips constant objectives. Repeated WASM memory samples for each final
fixture/budget stayed at the stated high-water with zero live models after
each request. These measurements exclude JavaScript/process overhead and do
not establish iPhone memory safety. At 5 seconds the old ordinary model used
72.88 MiB, versus the new 60.69 MiB; extra old search raised it to 87.50 MiB.

The extra split-case search materially improves the ascending free-gap vector:
at 5 seconds it is `[9,10,10,10,11,12,12,13,14,14,15,16,20,21]` days; at full
proof it is `[9,10,13,13,13,13,13,15,15,15,16,16,16,16]`. This is the agreed
leximin priority, rather than an average-gap gain. At equal higher objectives,
incumbents are retained by the whole objective vector so a later solve cannot
replace them with an equivalent current-stage result having worse later gaps.

Reproduce current/old comparisons from the repository root:

```sh
node --test tests/highs-spike.test.mjs
node scripts/benchmark-highs.mjs --seconds=5,30 --repeat=3 --nodes=1000000
pnpm exec tsc --noEmit
pnpm build
pnpm test:e2e:ci solver-spike.spec.ts
```

`--engines=old` or `--engines=new` measures one implementation; `--fixtures=`
selects the documented comma-separated names. The driver isolates native memory,
verifies every returned assignment, records fixture hashes, and removes only its
own temporary baseline source directory. Node 24 native TypeScript support is
needed for these commands. Longer budgets remain configurable; stopping early
after full proof avoids spending the unused time.

Practical starting budgets: assignment-only previews should stay separate from
spacing. Use **30 seconds / 1,000,000 nodes** as the cancellable generation default,
returning early on proof. A 5-second quick search is useful when explicitly
requested, but cannot promise the excellent remaining gaps of the split case.
An explicit 60-second or longer search can be offered when proof/quality is
still improving on the actual device; never continue after full proof. These
are workstation-informed starting settings, not an iPhone latency promise.
Progress posts independently verified incumbents and proof prefixes between
stages; synchronous WASM remains inside the Worker, with main-thread termination
for cancellation and request IDs rejecting stale responses.

Remaining gates: real supported iPhone Safari timing/memory/cancellation and
background/resume; actual Jerusalem/canonical owner normalization; authoritative
published/draft boundary reads and approval provenance; secondary identity and
eligibility adapters; final preferred-date/seed tie objectives; compensation;
revision-checked saves and the Generate opening-time gate. The normalized spike
does not authorize locks or read/write the database. Fixed settings reproduce
completed runs in the tested environment; wall-clock-limited results need not
reproduce. No production deployment or merge is performed by this follow-up.

### 14.6 Responsiveness, cancellation and search limits

Expose progress at useful stage changes/incumbents without rendering the entire
workspace for every solver callback. Keep the best verified incumbent on the
UI side where the wrapper permits progress delivery.

A synchronous WASM solve inside a Worker cannot process an ordinary cancel
message until it yields. Use Worker termination for reliable user cancellation;
use verified solver time/work limits for bounded completion. Do not require
SharedArrayBuffer or cross-origin isolation just to cancel. If interruption
terminates the Worker, recreate it for a later run and do not apply its result.

Budget total work across lexicographic stages. Stop honestly at the current
stage on timeout; do not claim lower-stage optimality. Debounced preview checks
can reuse immutable inputs/model structure, but no stale feasibility result may
enable saving a different allocation.

Benchmark actual workloads rather than invent latency numbers: normal
12-engineer months, two-engineer cap shortages, larger teams, tight/shared
availability, weighted special combinations, many split weekends/locks,
boundary drafts/publications and repeated edits.
Set measured UX/search budgets before release. Performance validation and
package selection are engineering gates, not new unresolved business questions.

### 14.7 Persistence, revision and security

Keep the existing draft/publication lifecycle: NULL-publication working rows
belong to open drafts; Publish validates full coverage and creates an immutable
version; Reopen/restore copies owned rows without replacing the live publication;
Cancel Draft deletes only that owner's working state. A partial generated draft
does not weaken the publication gate.

Store allocation provenance/confirmed targets and tentative repayment intent
with that draft; publication freezes the reviewed plan and source keys. Later
approved published swaps are explicit new commitments: their actual weighted
allocation can differ from the original generation targets and is accounted from
the approved change, not rejected merely for exceeding an old month's target.
Show changed workloads in the existing approval review.

Use the existing workspace revision lock for lazy reconciliation, publication,
manual ledger writes and generation saves. Recheck identity/manager authority
after obtaining the lock. Source keys make retries idempotent. A save checks
the captured allocation/problem fingerprint as well as revision; UTC time and
newly due settlements must be reconciled before accepting a stale repayment plan.
Return a refresh/review requirement instead of overwriting or altering targets.
The checked generation-result save must also reject a closed V1 generation
window using authoritative server time, even if revision/fingerprint are unchanged.
Sample that time after acquiring the workspace lock, immediately before accepting
the result; do not reuse a client/pre-lock time that could predate a lock wait.
Do not extend that rejection to otherwise permitted manual changes or swaps.

Only the checked server operation computes authoritative ledger effects.
Client solver output, member IDs, roles, exemption flags or supplied balance
totals are untrusted. Preserve private availability notes and existing approval,
last-admin, foreign-key, span, primary/secondary and consent protections.
Use the filtered approved-team/manager views from section 7.9; reasons/private
notes are not copied into public calendar content. A member-accessible lazy
reconciliation operation can persist only server-derived earned contributions,
never caller-supplied discretionary adjustments. It must perform the same
membership/revision/source checks. Direct client ledger mutation remains denied.

Future migrations follow [Supabase setup](SUPABASE_SETUP.md), preserving
canonical SQL, reviewed incremental migrations and fresh/upgrade security tests.
Release work follows [deployment rules](DEPLOYMENT.md), database-first ordering
and required approvals. No live change is authorized by this specification.

## 15. Generate, fresh Regenerate and publication lifecycle

### 15.1 One generation transaction

1. Read the selected owner's canonical blocks and authoritative server time.
   Reject Generate/Regenerate if coverage has started; otherwise read membership,
   constraints, locks, emergency coverage, publication/working boundary context
   and accepted revision.
2. Lazily reconcile actual compensation at server time and build a separate
   projection through the selected month's operational opening.
3. Calculate `P`, the ordinary fair baseline and normalized oldest-feasible
   compensation proposal; preserve explicit transfer provenance.
4. Open the single allocation popup, showing actual/projected context, targets,
   Permanent, Locked, Generate and monthly totals. Reset the edit step to 1.
5. Apply manager edits and counterpart redistribution; classify temporary,
   permanent and deferred repayment units without posting draft ledger events.
6. Validate structural invariants. Present global full/partial/unknown findings
   inline; known full infeasibility does not block a run.
7. Recheck the V1 generation window, confirm targets and freeze the problem
   snapshot. Draw and record a fresh seed.
8. Build a fresh arrangement: discard all unlocked selected-month primaries
   from solver constraints, including ordinary manual edits and draft swaps.
9. Optimize the optional-coverage model lexicographically; retain only valid
   incumbents and honest proof status.
10. Independently validate the output and its deficits/objectives.
11. Save the owner-scoped complete or partial draft under checked revision/
    fingerprint/time-window control, preserving locks, emergency assignments and
    history. A window that closed during solving rejects the result.
12. Present the calendar and target/assigned/missing points. Only the separate
    Publish workflow can commit a complete schedule and ledger intentions.

Existing accepted working rows remain until a valid new result is committed;
cancellation, runtime failure or stale saves do not first erase the old draft.
This does not turn old unlocked primaries into solver constraints.

### 15.2 Every Generate is fresh

Regenerate is the same fresh generation process with a new seed and the same
V1 cutoff; it is unavailable once owner-month coverage starts.
Preserve the manager-confirmed target table unless the manager explicitly edits
or accepts a refreshed proposal. Preserve availability, locks, weekend structure,
special duties, emergency coverage, neighboring assignments and actual ledger.

Do not preserve or prefer old draft swaps/unlocked manual primary choices.
Only explicit locks preserve those assignments. Rebuild tentative duty-to-
repayment attribution for the fresh arrangement without changing obligations.

If reconciliation/input edits invalidate the old allocation's compensation plan,
show the refreshed proposal for manager confirmation. Retain old numbers as
reviewable input, never silently apply changed targets. If the manager keeps
them, revalidate and explicitly classify any changed transfer intent; do not
settle an already closed obligation again.

### 15.3 Save partial; publish complete

A partial draft retains its original confirmed totals. Each hole and each
unmet engineer target stays visible. Managers can manually resolve it with
explicit locks/overrides, or revise targets and run again while the V1 generation
window remains open. After coverage starts, resolution uses manual changes and
swaps; a partial draft does not extend or reopen the window.

Before publication, all required primary duties must be covered and the current
reviewed target/lock/integrity rules satisfied. A manual change that alters the
draft's point allocation requires allocation review rather than an implicit
solver target change. Publication applies pending ordinary temporary intents
once and freezes any future repayment reservations; no future duty is yet settled.

Draft swaps create no debt until they are part of an authoritative transition.
Publishing an unchanged copied allocation does not replay old temporary charges.
Published replacements/swaps then produce their correctly classified source
effects once through the existing checked approval/publication path.

The manager primarily manages current/future work. Historical previews are
read-only for compensation. Exceptional corrections use explicit audited
operations and never automatically rewrite later published months.

### 15.4 V1 generation window and future remainder-only generation

**Disable Generate and Regenerate at or after `coverageStart(M)`**, defined in
section 3.1. This applies even if the month has no publication, a partial/unassigned
draft or only unlocked assignments. Locking, unlocking, reopening, cancelling a
draft or replacing a publication does not reset the canonical start instant.

The UI mirrors the cutoff and explains it inline. Recheck authoritative time
when preparing the request, before starting a solve and in the checked save
transaction. If the cutoff passes with the popup open, disable its action. If a
solve is running, cancel/invalidate it; a result arriving after the cutoff is
discarded even if its inputs and revision still match. Never erase the accepted
draft or post compensation merely because a late solve is rejected.

Manual assignment changes, locks/unlocks and swaps remain available under their
existing permissions, date eligibility, consent, revision and publication rules.
The generation cutoff does not authorize historical edits or weaken any such
rule. Future owner months remain eligible before their own opening instant.

**Future enhancement, explicitly out of scope for V1:** remainder-only generation
could preserve started/completed authoritative duties and optimize only unstarted
work. It would need explicit fixed-history point accounting and remaining-target
presentation alongside manual locks. V1 neither implements that mode nor converts
past work into implicit locks to approximate it.

## 16. Worked examples

Amounts in this section are points. Illustrative baselines are assumed reviewed
for the stated duty weights; they do not introduce seniority multipliers.

### 16.1 Exact arithmetic is necessary, not sufficient

A 34.5-point month contains 69 half-point units.
`3 × 2.5 + 9 × 3 = 34.5` is a balanced target total for 12 engineers.
It is attainable only if the actual duties permit those individual totals.
If only one block has an odd number of half-point units and all other blocks
have even units, three separate odd-unit targets cannot all be met. The sum
alone is not a feasibility proof.

Target 3, Locked 1 means Generate requests 2 more. Locked 3 means no more.
Locked 4 is structurally invalid; a target with an unattainable remainder is
instead eligible for clearly labeled partial generation.

### 16.2 Ordinary published replacement

Daniel has a published 2-point ordinary responsibility. Noam replaces him.
Create Daniel -> Noam 2 exactly once for that authoritative transition.
Daniel's net indicator changes by −2 and Noam's by +2.
A draft-only replacement creates no event.
This example has no prior repayment attribution; section 16.13 covers a
cancelled repayment instead.

### 16.3 Weighted published swap

Daniel's 1-point duty and Noam's 3-point duty exchange primaries.
Daniel carries 2 more; Noam carries 2 less. Create Noam -> Daniel 2.
An equal-weight swap creates no new claim. Secondary cover and point weights
remain attached to their dates. Do not additionally charge a monthly fairness
difference for this same transaction.

### 16.4 Temporary plus permanent

Offered targets are E 2, A 2, B 2. The manager gives E Temporary +1 funded by
A −1, and E Permanent +1 funded by B −1:

| Engineer | Final Target | Temporary | Permanent |
|---|---:|---:|---:|
| E | 4 | +1 | +1 |
| A | 1 | −1 | 0 |
| B | 1 | 0 | −1 |

Total remains 6. After publication, A owes E 1 for the ordinary temporary burden.
B's deliberate permanent transfer creates no claim. If E has 1 locked point,
Generate requests 3 additional points and may never exceed final Target 4.

For a permanent increase with eligible donors A 4 and B 4, both above locks,
choose the more senior donor. If A already has 4 locked, A cannot donate a point;
choose the next eligible donor or leave the table edit pending.

### 16.5 Deferring existing compensation without doubling it

Use a hypothetical reviewed baseline Daniel 2, Creditor 4, Recipient 2 and
existing Daniel -> Creditor 3. Proposed targets are 5, 1, 2.
Daniel asks for a temporary limit of 4; Recipient is the selected eligible
counterpart and receives 3. Creditor stays at 1. Total stays 8.

Daniel can now perform only 2 extra points relative to his baseline.
Creditor still receives 3 of relief; Recipient carries the remaining 1.
The coherent plan is:

- Reserve 2 of Daniel's future duty points to repay Creditor.
- Record the remaining temporary ordinary burden as Creditor -> Recipient 1.
- Normalize Daniel -> Creditor 3 plus Creditor -> Recipient 1 into
  Daniel -> Creditor 2 and Daniel -> Recipient 1.
- Once Daniel's attributed 2 points finish, only Daniel -> Recipient 1 remains.
  Its provenance retains the old claim's age.

Do not retain Daniel -> Creditor 1 **and** independently add Daniel -> Recipient
1 after claiming the same deferred point twice. Final outstanding amount for
Daniel is 1, not 2. The selected counterpart chain explains who carried it.
No event occurs while the edited allocation remains an unpublished draft.

### 16.6 Oldest feasible and partial repayment

Debtor owes B 2 from January and C 1 from February.
Only 1.5 can feasibly be allocated for repayment this month.
Reserve 1.5 for January; after the attributed work completes, B is still owed
0.5 and C 1. Do not round January up, erase its remainder, or favor February.

If January cannot receive any feasible repayment in this proposal but February
can receive 1, reserve that 1 for February and keep January's full 2 with its
original priority. No arbitrary “one point per month” rule applies.

### 16.7 Netting, provenance and inactive intermediaries

| Source obligations | Normalized active obligations |
|---|---|
| X -> Y 2; Y -> X 1 | X -> Y 1 |
| X -> Y 2; Y -> Z 1 | X -> Y 1; X -> Z 1 |
| X -> Y 1; Y -> Z 1; Z -> X 1 | None |
| X -> Y 2; Y -> Z 1; Z -> X 0.5 | X -> Y 1; X -> Z 0.5 |

In the second row, paying 0.5 of X -> Z reduces the contributing X -> Y and
Y -> Z raw legs by 0.5 each. X's net improves by 0.5; Z's falls by 0.5;
Y's is unchanged. There is one 0.5-point repayment.

If Y was already inactive when those relationships arose, retain X -> Y 2 and
Y -> Z 1 as frozen relationships; do not bypass Y to activate repayment with Z.
If the claims had already normalized to X -> Z while Y was active, its later
deactivation does not reverse that valid result or require Y to participate.
Unrelated active edges continue. Source events survive normalization/reactivation.

### 16.8 Calendar coverage beats total point weight

Consider two unlocked remaining blocks: an ordinary combined weekend worth 1
covering 2 dates, and a nonadjacent special weekday worth 5 covering 1 date.
Remaining targets are A 5 and B 1, matching the 6 required points.
A can cover either but not both; B is unavailable for both.

| Choice | Dates covered | Assigned points | Total unmet points |
|---|---:|---:|---:|
| Combined weekend to A | 2 | 1 | 5 |
| Special weekday to A | 1 | 5 | 1 |

Choose the combined weekend: priority 1 is calendar-day coverage.
The special remains visible and A has 4 unmet, B 1. Do not exceed A's target
by assigning both or use priority 3 to reverse priority 1.
Other already fixed duties/context are identical between these alternatives.

### 16.9 Special priority precedes missing points

The remaining alternatives are an ordinary weekday worth 1 and a separate
special Friday worth 0.5, each covering one date. The rest of the canonical
weekend/month is fixed consistently. Remaining targets are A 1 and B 0.5;
only A is available for these two blocks and cannot take both.

Both choices cover one date. Choose the marked special Friday even though
it leaves 1 total point unmet, compared with 0.5 if the ordinary weekday were
covered. Priority 2 precedes missing-point minimization. Extra-point magnitude
does not define importance.

### 16.10 Cross-year weekend and spacing

Friday 31 December 2027 and Saturday 1 January 2028 are December-owned:

| Structure | December points | January points from that weekend |
|---|---:|---:|
| Combined ordinary | 1 | 0 |
| Split ordinary | 0.5 + 0.5 | 0 |
| Special daily +2 each | 2.5 + 2.5 | 0 |

Combined coverage ends on Sunday 2 January at 09:00. Its engineer cannot receive
an automatic consecutive Sunday duty in January. An owner-scoped January save
cannot modify either December weekend half.

For three one-day November duties without offset changes/binding boundaries,
dates 1, 8, 29 give free gaps 6 and 20 days; dates 1, 15, 29 give 13 and 13.
The second arrangement has the better minimum elapsed gap. With a mandatory
locked zero gap elsewhere, the secondary gap vector still improves the
remaining shortest gaps rather than treating all arrangements as equally good.

### 16.11 Early generation and a late projection change

On 25 October, Daniel actually owes Creditor 2. Published October work reserves
1 point for repayment on Friday 30 October, ending Saturday 31 October at 09:00.
Generating November uses projected opening debt 1, while actual debt remains 2
until that duty finishes.

Suppose the Friday is a split special half worth 1 (0.5 base + 0.5 extra).
An explicit reviewed October change removes the extra before completion, keeps
the primary and split structure, updates October allocation and reduces usable
repayment capacity to 0.5. There is no new debtor for the removed point weight.
The revised projected November-opening debt is 1.5; actual debt is still 2
until completion, then 1.5.

If November was already published using the earlier projection, it stays
unchanged. The next Generate considers the corrected balance. A second Users
access or reconciliation cannot settle the same 0.5 again.

### 16.12 Indivisible duties and a half-point claim

Debtor owes Creditor 0.5. If their otherwise fixed baseline/targets can only
change in whole-point combinations under the current duties, no exact 0.5
repayment is available. Carry 0.5 forward. Do not round it to 1, split an
ordinary primary duty into two people, or add a permanent transfer without
explicit manager action just to make the numbers fit.

### 16.13 Cancelled repayment and a separate ordinary component

Daniel owes Noam 2. A future published 2-point duty assigned to Daniel is
reserved to repay exactly those 2. Before its end, Noam replaces Daniel through
an authoritative published change.

- Cancel the 2-point repayment reservation and retain its audit history.
- Daniel's actual outstanding debt remains exactly 2; create no new obligation
  for that attempted repayment and record no earned settlement/reversal.
- If the projection previously assumed this duty completed before its cutoff,
  its projected debt changes from 0 back to 2. Noam's completing the replacement
  duty does not settle Daniel's debt.
- Repeated reconciliation or unchanged publication copies leave the debt at 2,
  never 4. Any already published future schedule stays unchanged.

If instead Daniel's replaced duty is worth 3, with 2 earmarked for that repayment
and 1 ordinary point, cancel the reserved 2 without a new charge. The independent
ordinary point creates Daniel -> Noam 1 once; total outstanding debt becomes 3,
not 5. Keep the two source meanings distinct.

### 16.14 Owner-month opening and an in-flight result

January 2028 starts on Saturday. Friday 31 December and Saturday 1 January
are December-owned; January's first owned duty starts Sunday 2 January at 09:00
in `Asia/Jerusalem`. January Generate/Regenerate is available before that instant
and disabled at or after it, regardless of publication/draft status. December's
ongoing weekend on 1 January does not close January's window early.

A January solve started at 08:59 but saved at 09:00 or later on 2 January must
be rejected without changing the accepted draft, locks, secondary coverage or
ledger. Manual changes and swaps remain available under their existing rules.

## 17. Edge cases and operational outcomes

| Situation | Outcome |
|---|---|
| No active eligible engineers | No valid positive target distribution; explain membership setup before generating. Do not invent identities. |
| Engineer target zero | Assign no primary work; nonzero locks make it invalid. |
| Entirely unavailable engineer with a positive valid target | Retain the target as a ceiling and report its unmet points in a partial result. |
| Shared or weighted feasibility failure | Produce the best valid partial schedule; never “fix” targets in the date solver. |
| Approved lock conflicts with an available candidate's only slot | Preserve lock, optimize remaining coverage and show scarcity. |
| Unapproved conflicting locks | Structural error; no solver policy can choose which mandatory lock to discard. |
| Two engineers and many weekends | Preserve the cap and return uncovered weekends; alternate feasible weekdays. |
| Five split weekends | Separate-day consecutiveness and distinct-weekend cap may require more participants than combined weekends; do not merge them automatically. |
| First-of-month Saturday / year boundary / leap day | Canonical coverage/ownership remains exact; no date is duplicated or lost. |
| Neighbor publication differs from its draft | Both bind as labeled context; neither is rewritten; only published work enters repayment projection. |
| Preserved inactive/unavailable secondary | No primary points or spacing effect; keep publication integrity warning for separate manager review. |
| Special/lock/point total changes after confirmation | Invalidate old result, retain numbers for review and require explicit allocation confirmation. |
| Replacement/weighted swap after publication | One classified authoritative transition, preserving exemptions and repayment provenance; cancelled repayment units create no duplicate obligation. |
| Repeated publication with new physical duty IDs | Stable lineage prevents new duplicate work, debt or settlement. |
| Partial unpublished draft | No compensation from unmet nominal targets or draft edits; Publish requires resolution. |
| Inactive debtor/creditor | Preserve/freeze incident claims; active unrelated obligations progress. |
| Inactive intermediary with zero net | Show frozen counterpart details; do not silently bypass the freeze. |
| Repayment not feasible for several months | No expiry or arbitrary cap; preserve age and try feasible units next proposal. |
| Projection changes after a future month was published | Correct underlying ledger/projection; no automatic schedule rewrite. |
| Manual compensation crosses zero | Require explicit selected reverse direction; never create a hidden reverse claim. |
| Cancellation/runtime failure | Keep the accepted draft; no stale application or synthetic infeasibility claim. |
| Timeout with verified partial incumbent | Present/save as partial best found, with unproved stages stated. |
| Unique valid/equal-quality arrangement | New seed may reproduce it; invalid or lower-quality variety is not acceptable. |
| Owner-month coverage has started, even with no publication or incomplete draft | Disable/reject Generate and Regenerate; retain manual changes/swaps under existing rules. Remainder-only generation is out of scope for V1. |
| Coverage starts during allocation/solving/saving | Invalidate/cancel the request and reject a late result using server time; accepted draft and ledger remain unchanged. |

## 18. Future acceptance matrix and readiness

This is the acceptance matrix for the full redesign. The isolated engine's
implemented checks are documented in [GENERATION_ENGINE.md](GENERATION_ENGINE.md),
[ALLOCATION_PLANNER.md](ALLOCATION_PLANNER.md) and [ALLOCATION_DATABASE.md](ALLOCATION_DATABASE.md).
Application coverage is exercised by the allocation and workspace browser suites.
The original 57 IDs M1–M12, B1–B12, F1–F9, D1–D8, U1–U8 and I1–I8
are retained with corrected outcomes. Additional IDs cover the new decisions.
Replace intentionally obsolete expectations while preserving unrelated
regressions. Use synthetic data; do not validate permissions on live members.
Unless a scenario exercises the cutoff, generation workflow fixtures use an
owner month whose coverage has not started. Pure solver tests remain independent
of the UI/server time gate.

### 18.1 Mathematical solver tests

| ID | Scenario | Required observable result |
|---|---|---|
| M1 | Fully feasible ordinary month | Each block has one primary, assigned units equal every target and all deficits are zero. |
| M2 | Half-point targets/weights | Exact unit sums; 1.1 input rejected rather than rounded; no fractional primary assignments. |
| M3 | Target 3 with only a 4-point candidate | Candidate remains unassigned to that engineer, unmet 3 shown; other valid work generated. |
| M4 | Two engineers target 3 each, same three separated one-point slots only | At most 3 of 6 points assigned between them; shared shortage proved when search completes; partial generation allowed. |
| M5 | Two constrained engineers with disjoint three-slot opportunities | Preserve their scarce slots and achieve each exact 3 when the rest of the model permits full coverage. |
| M6 | Same engineer is the only candidate for two consecutive days | At most one day assigned; no target increase or consecutive exception invented. |
| M7 | Fixed previous/next primary touches selected boundary duty | That engineer cannot receive the conflicting automatic duty, including Friday-owned cross-month ranges. |
| M8 | Two engineers, five combined weekends, no exceptions | At most two weekend blocks/four weekend dates assigned automatically; remaining weekends visible. |
| M9 | Valid locks plus scarce remaining opportunities | Every locked variable is retained; no extra work beyond target, even if keeping a lock reduces coverage. |
| M10 | Enumerable spacing alternatives 6/20 versus 13/13 days | With identical higher objectives and context, choose 13/13; a distant duty cannot hide the close pair. |
| M11 | Complete proof, verified partial, optimal partial and timed-out incumbent | Distinct completeness/proof/termination fields; no timeout reported as mathematical infeasibility or optimum. |
| M12 | Identical input/version/settings/seed/work budget | Reproduce the specified result; new seeds vary only equivalent valid alternatives and uniqueness is permitted. |
| M13 | Section 16.8 weekend 1 versus special weekday 5, targets 5/1 | Choose two-date weekend, assigned 1 and total missing 5; do not maximize point weight first. |
| M14 | Section 16.9 special Friday 0.5 versus ordinary weekday 1 | At equal one-date coverage, choose special Friday despite larger point deficit. |
| M15 | Arbitrary valid partial result | Sum of engineer deficits equals unassigned duty units; configured targets still sum to all required units. |
| M16 | Locked zero gap plus two movable gap patterns | Minimum remains zero; secondary gap ordering chooses the better remaining small gaps. |
| M17 | Structurally valid locks and no usable automatic edges | Locks plus all other u=1 form a valid partial incumbent; optional model is not reported infeasible. |
| M18 | Variable number of assigned blocks at equal higher objectives | Successor gaps/padded comparison follow section 11; no off-month-only or unassigned-duty gap is scored. |
| M19 | Equal minimum gap, one member with a weekend turn this cycle | The weekend goes to the member without a turn; a preferred weekend date, the gap distribution or the seed cannot override it; the minimum gap can. |
| M20 | Equal minimum gap, choices differing in repeated weekdays | The lower repeat count is chosen and proved over a better gap distribution or a preferred date; the independent validator reports the count. |
| M21 | Ordinary month, several seeds | Identical gap vectors, distinct schedules, and variation spread across the whole month rather than the last duties. |

### 18.2 Business-rule tests

| ID | Scenario | Required observable result |
|---|---|---|
| B1 | Eight ordinary points, three otherwise equivalent eligible engineers | Ordinary proposal senior-first 2/3/3; compensation outranks this remainder tie; no seniority multiplier. |
| B2 | Ordinary combined/split weekend | Combined 1 or separate 0.5/0.5; one shared Friday identity; primary-only distinct-weekend counting. |
| B3 | 31 December 2027 / 1 January 2028, leading Saturday and leap day | Weekend entirely December-owned; no independent January Saturday; leap date covered exactly once. |
| B4 | Two special weekend dates, +2 each, cross-owner range | Two 2.5 duties, no combined extra base; owner-scoped dates/points preserved. |
| B5 | Availability/consecutive manager exceptions | Specific reviewed fixed assignment/pair retained; automatic neighboring violations remain prohibited. |
| B6 | Target 3 with locks 1, 3 or 4 | Remaining 2, 0, or structural invalidity respectively; equal locks receive no extra primary points. |
| B7 | Engineer unavailable all month; everyone unavailable on a duty | Valid targets remain unchanged; corresponding deficits and uncovered dates shown in partial output. |
| B8 | Temporary decrease, next recipient blocked, newest reached | Skip globally blocked recipient, wrap once, preserve source/counterpart provenance and exact half units. |
| B9 | Permanent increase; eligible donors both target 4 | Choose most senior highest-target donor; a donor locked at 4 cannot donate below 4; no new IOU. |
| B10 | Secondary e1 retained on duty, e1 otherwise best primary | e1 excluded only by identity integrity; secondary earns no primary points, cap, spacing or compensation. |
| B11 | Special, constraint, lock, member or boundary changes during validation | Old fingerprint rejected; no silent target total or lock repair. |
| B12 | Draft swap/manual primary edit followed by Generate | Unlocked primaries discarded from constraints; explicit locks/targets/secondary structure retained. |
| B13 | Redistribution lacks an automatic feasible recipient | Requested reduction remains pending; total warning shown. Explicitly balanced infeasible final table permits partial generation. |
| B14 | A duty acquired through a permanent transfer is later ordinarily replaced | Original exemption persists; the separate new ordinary transfer is classified once, not permanently exempted by duty identity. |
| B15 | Debtor offered 5, manager temporarily confirms 4 | Assigned points never exceed 4; unperformed repayment carries forward; solver cannot restore 5. |
| B16 | 0.5 claim, only whole-point realizable target changes | Do not round/overpay; leave 0.5 outstanding unless reviewed adjustments make it feasible. |
| B17 | Valid locks on two explicitly approved weekends | Those weekends retained; no third automatic weekend or blanket consecutive exception. |

### 18.3 Compensation-accounting tests

| ID | Scenario | Required observable result |
|---|---|---|
| F1 | Ordinary temporary A −1, B +1 | No draft event; first authoritative publication creates A owes B 1 once. |
| F2 | Permanent A −1, B +1 | Neither side gains debt/credit for this transfer. |
| F3 | Section 16.4 temporary + permanent to E | Final targets 4/1/1; only A owes E 1; B's permanent transfer creates no claim. |
| F4 | Vacation blocks repayment over three months | Same outstanding units and original age persist, with no expiry or invalid assignments. |
| F5 | Four points can feasibly be repaid in one month | Propose all 4 before ordinary fairness ties; no arbitrary monthly cap. |
| F6 | Published Daniel 1 / Noam 3 weighted swap | Noam owes Daniel 2; unchanged permanent provenance preserved; equal-weight swap adds no claim. |
| F7 | Repeated replay/publication/source retry | Same source/idempotency key yields one effect; unchanged copied intent is not charged again. |
| F8 | New, inactive and reactivated members | New has no imported debt; inactive incident edges frozen; reactivation retains units/age and history. |
| F9 | Draft replacements, swaps, regeneration, reopen/cancel | No new ledger origins/settlements from those draft changes; independently due published work may still reconcile. |
| F10 | X owes Y 2; reserve 1 repayment | Proposed X +1/Y −1; Users net X −2/Y +2 until actual completion, then −1/+1. |
| F11 | X -> Y 2 and Y -> X 1 | Normalized X -> Y 1; underlying two events retained. |
| F12 | X -> Y 2 and Y -> Z 1 | X -> Y 1 plus X -> Z 1; each engineer's net conserved. |
| F13 | X -> Y 2, Y -> Z 1, Z -> X 0.5 | X -> Y 1 and X -> Z 0.5 after deterministic netting. |
| F14 | Equal cycle, longer cycle, shuffled raw row order | Cyclic amount cancels, net positions unchanged; identical normalized endpoints/provenance regardless of input order. |
| F15 | January claim 2, February 1; repayment capacity 1.5 | January receives 1.5 after completed work; residual January 0.5 and February 1. |
| F16 | Old claim infeasible, later claim can receive 1 | Later claim progresses by 1; old claim stays whole and keeps priority for the next proposal. |
| F17 | Normalize, increase an old obligation, normalize again | Residual old units retain age; added units carry new source time; derived normalization idempotent. |
| F18 | Manual + on A, counterpart B, amount 0.5 | Explicitly create B -> A 0.5 with reason/history; it enters ordinary future repayment. |
| F19 | Manual decrease larger than selected outstanding amount | Do not silently cross zero; require an explicitly reviewed reverse obligation/correction. |
| F20 | Manual partial/full settlement or correction | Append reasoned event, preserve original, change both endpoints consistently and reject negative outstanding amounts. |
| F21 | Ordinary published Daniel duty 2 replaced by Noam | Daniel -> Noam 2 once; no claim from merely editing the draft. |
| F22 | Future published repayment; before/at/after actual end | No settlement before end; once at end<=now, one settlement; repeated later access changes nothing. |
| F23 | October actual debt 2, published pending repayment 1 before November opening | Actual 2, projected November opening 1; unpublished drafts/historical copies excluded. |
| F24 | Section 16.11 pending duty weight drops usable repayment from 1 to 0.5 | Projection becomes 1.5; actual remains 2 until end, then 1.5; published November unchanged. |
| F25 | Two tabs reconcile the same completed contribution | One earned settlement under lock/unique key; no duplicate balance reduction. |
| F26 | Repay normalized X -> Z 0.5 through Y | Both raw path legs reduced by 0.5; endpoints change by 0.5 each, Y net unchanged, one repayment. |
| F27 | Ordinary baseline remainder/new random arrangement | No new compensation merely for baseline workload/date differences. |
| F28 | Section 16.5 debtor target lowered by 1 and recipient carries it | After planned 2 actually complete, debtor owes Recipient 1, not two duplicated residual points. |
| F29 | Extra required point weight added/removed with same primary | No fabricated counterparty debt; allocation/repayment capacity explicitly reviewed. |
| F30 | Daniel owes Noam 2; Noam replaces him on an uncompleted duty reserved to repay those 2 | Cancel the reservation; actual debt remains exactly 2, projected debt returns from 0 to 2 if previously included. No new debt/settlement/reversal; Noam completing it or repeated access/publication copies never changes it to 0 or 4. |
| F31 | Deactivation after work end but before next lazy access | Checked deactivation reconciles earned work first; freeze cannot erase earned settlement. |
| F32 | Duty ends during inactive participation freeze | No automatic projected/actual settlement on reactivation; explicit recorded resolution required for that held work. |
| F33 | Stored ordinary baseline 2, debt 3, final Target 5, Locked 3 | Locked duties count inside the 5 and can fund the planned 3; do not inflate the ordinary baseline to 3 and erase repayment capacity. |
| F34 | Whole-point ordinary baseline tie 1/2 or 2/1, newer A owes B 2 | If all 3 points can be assigned to A, choose ordinary A 1/B 2 then repay 2; do not first favor newer A 2/B 1 and unnecessarily limit repayment to 1. |
| F35 | Ordinary combined A weekend becomes Friday A / Saturday B | Compare 0.5-point date atoms, create A -> B 0.5 once; no extra combined-weekend charge and no emergency points. |
| F36 | Ordinary share A 2; absence-driven proposal A 0, B carries those 2 | Record an explicit pending temporary A -> B transfer; no draft debt, A owes B 2 on publication; do not silently reset A's ordinary baseline to zero. |
| F37 | Y becomes inactive before versus after active X -> Y -> Z normalization | Before: new incident claims frozen, no bypass. After: existing X -> Z remains active, Y is provenance only; replay order stable and no normalized claim silently reassigned. |
| F38 | Late correction refers to a source before a committed freeze/netting event | Append a current-sequence adjustment with original provenance; do not reorder committed business events or reconstruct different historical counterpart/freeze decisions from current row order. |
| F39 | Section 16.13 replacement of 3 points: 2 repayment, 1 ordinary | Cancel the 2-point reservation; create only Daniel -> Noam 1 for the separate ordinary transfer; total debt 3, not 5. |

### 18.4 Database integrity and security tests

| ID | Scenario | Required observable result |
|---|---|---|
| D1 | Anonymous/pending/inactive/engineer attempts manual ledger mutation | Denied; only checked manager authority can create/correct discretionary obligations. |
| D2 | Demotion, identity change or revision race while solving/saving | Stale/unauthorized operation fails atomically; no old result or ledger change applied. |
| D3 | Lock/allocation/repayment metadata save, publish, reopen/restore | Reviewed metadata and lineage round-trip; immutable publication and ledger history retained. |
| D4 | Duplicate primary/secondary, missing FK or invalid duty span | Database/checking rejects it even with manager scheduling override flags. |
| D5 | Half-unit persistence and reassignment | Exact weights survive; points remain on duty slots; off-denomination values rejected. |
| D6 | Save partial draft; attempt Publish; injected transactional failure | Draft save succeeds if valid; incomplete Publish rejected; rollback leaves all owners/ledger intact. |
| D7 | Engineer or unauthorized viewer requests private notes/reason data | Existing note privacy maintained; no availability note copied into ledger/public calendar; role-scoped audit view enforced. |
| D8 | Published swap and repeated callback/approval retry | Existing consent/admin checks preserved; one commitment transition, no duplicate ledger amount or history rewrite. |
| D9 | Publication row IDs change or an old version is deleted | Stable source keys prevent replay; deleting a version does not cascade away ledger events/earned effects. |
| D10 | Client forges time, balance, permanent flag or settlement amount | Checked server recomputes trusted source effects and end-time eligibility; forged client values do not authorize writes. |
| D11 | Concurrent lazy access and manual correction | One revision-locked order, exact replay and source uniqueness; global sum(net)=0. |
| D12 | Correction of a previously reconciled source | Append one referenced adjustment/reversal, no deletion or duplicate settlement, later publications unchanged. |
| D13 | Generation save at/after owner opening despite unchanged revision or forged client time | Checked save rejects it using authoritative server time; accepted draft/ledger unchanged. Permitted manual writes/swaps remain governed by their own existing checks. |

### 18.5 UI interaction tests

| ID | Scenario | Required observable result |
|---|---|---|
| U1 | Phone/desktop and English/Hebrew | One usable popup with required columns, senior-first order, RTL/LTR and keyboard/focus access. |
| U2 | Open/reopen, + / − and step toggle | Step resets to 1 on each opening; 0.5 edits exact; counterpart/final target clear. |
| U3 | Target 3, Locked 1, Assigned 2.5 | Generate request initially 2; final Target stays 3, assigned 2.5 and missing 0.5 shown. |
| U4 | Wrong sum/lock floor versus proved complete infeasibility | Invalid inputs disable Generate; balanced infeasible input still generates and saves a partial result (no in-dialog proof since 2026-10-30). |
| U5 | Pending/UNKNOWN, timeout incumbent, Cancel or stale result | Honest status; no false impossibility/optimum; cancelled/stale result not applied. |
| U6 | Explicit unavailable-date lock and scoped exception | Unavailability retained; manager approval/lock visible; ordinary unlocked edits remain distinct. |
| U7 | Partial output with uncovered combined weekend | Both uncovered dates marked, full block points and per-person deficits retained, Partial/Requires Manager Resolution visible. |
| U8 | Complex shared-capacity explanation | Names/dates/points and known limits inline; no extra conflict modal or primary solver jargon. |
| U9 | Users indicators and counterpart details | +2 means owed, −1 means owing; linked normalized and frozen details inspectable. |
| U10 | Manual compensation create/increase/decrease/settle/correct | Counterpart/direction/reason required as specified; no hidden reverse claim or deleted history. |
| U11 | Auto redistribution cannot balance an edit | Requested limit retained; monthly imbalance inline; consuming pending points preserves source/type. |
| U12 | Compensation projection changes before next Generate | Refreshed proposal reviewed explicitly; confirmed targets never silently rewritten. |
| U13 | Owner coverage starts while the allocation popup is open | Disable both Generate/Regenerate with an inline manual-change/swap explanation; retain accepted data and no second modal. |

### 18.6 Integration and performance tests

| ID | Scenario | Required observable result |
|---|---|---|
| I1 | Typical 12-engineer month, cold and warm solves | Record model/solve/save times and memory against measured release budgets; full and partial flows complete. |
| I2 | Small/large teams, tight availability, special weights, many splits/locks | Every incumbent satisfies hard rules; stopped stages/proofs accurate; no lower-tier trade of coverage. |
| I3 | Cancel synchronous WASM solve; change identity/input; retry | Worker terminates responsively; no stale save; new run has a fresh request/seed and clean resources. |
| I4 | Actual supported iPhone Safari and pinned Next.js production build | WASM assets load, repeated solves/cancel work within measured budgets; emulation alone not accepted as device proof. |
| I5 | Neighbor current publication A differs from open working B | Both labeled boundary guards enforced; neither owner changed; only publication enters compensation projection. |
| I6 | Duty completion becomes due while an allocation/save is in progress | Checked reconciliation/fingerprint prevents outdated plan application; manager review required rather than target mutation. |
| I7 | Multiple fresh Generate actions after draft swaps | New seeds; unlocked choices not constraints; locks/targets/secondary/structure/ledger preserved. |
| I8 | Cross-owner Special Block edit with a published neighbor | No silent reopen/change; only explicitly reviewed owner drafts updated atomically; generation remains owner-scoped. |
| I9 | Users/Generate access repeatedly, no timer job | Lazy actual/projected view correct; earned settlements idempotent; no daily background dependency. |
| I10 | Publish/swap copies current month to new physical rows | One logical commitment/attribution history; identical copied duties not counted twice. |
| I11 | Late October change after November publication | November assignments/pointer unchanged; next proposal uses corrected October projection/actual facts. |
| I12 | Deadline stops after coverage proof but before spacing proof | Present the valid best result with coverage proof only; no overall optimality claim. |
| I13 | Adapter accidentally returns LP fractional x values | Independent validator rejects them; no fractional/rounded duty or misleading complete draft saved. |
| I14 | Future migration fresh replay and upgrade from existing schedules | Existing publications/notes/revisions preserved; only explicitly reviewed opening obligations imported, no invented historical fairness debt. |
| I15 | Selected owner's canonical coverage has started, with published work or an unpublished incomplete draft | Generate/Regenerate disabled and requests rejected; no remainder-only mode. Manual changes/swaps retain existing permissions and date eligibility; reopening/unlocking cannot reset the cutoff. |
| I16 | January 2028 starts Saturday; compare just before and at Sunday 2 January 09:00 Jerusalem | January remains eligible during December-owned 1 January; eligible before its Sunday opening, disabled at equality/after. December's cutoff remains its own opening, with no double-owned Saturday. |
| I17 | Solve begins before owner opening but completion/save reaches the cutoff | Cancel/invalidate/discard the late result even if revision matches; no draft/lock/secondary/ledger change, and later months retain their own generation windows. |

### 18.7 Implementation gates

Before implementation delivery:

1. Implement pure integer/model/ledger validators and source-key invariants
   alongside the affected behavior, preserving the existing engine/storage split.
2. Verify the solver adapter/package/license/Next.js/Worker/device gates before
   adopting a dependency; measure limits rather than invent latency promises.
3. Test complete and partial coverage objectives against small independently
   enumerable instances, then constrained realistic months.
4. Test ledger replay, normalization, inactive freezes, projections, cancelled
   repayment and retries using the precise amounts above.
5. Enforce persistence/auth/revision/publication behavior and the V1 generation
   cutoff with disposable database and upgrade regressions; client-only tests
   are insufficient.
6. Review existing real opening obligations explicitly if they need importing.
   Never reconstruct debts from old heuristic inequality or every historical
   publication copy. Import verified linked amounts with source/reason.

### 18.8 V1 scope and implementation readiness

**The specification is implementation-ready; no blocking product decisions
remain.** Cancelled repayment preserves the original debt without a duplicate
obligation (sections 7.3 and 16.13). Generate/Regenerate is limited to owner-month
coverage that has not started, with manual changes and swaps preserved under
existing rules (sections 3.1, 15.4 and 16.14).

Remainder-only generation is a future enhancement explicitly outside V1. The
remaining solver/package/device/migration gates are normal implementation and
release validation, not unresolved product policy. This documentation update
does not authorize implementation, dependency installation, migration, merge or
deployment; implementation requires its separately authorized task.
