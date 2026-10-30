# Allocation and generation database boundary

Application Generate now uses these RPCs through the single allocation popup and
cancellable allocation/scheduling Workers. The [specification](GENERATE_ALGORITHM.md)
remains authoritative. No hosted migration or deployment is authorized by this implementation.

The workspace shares identity/save locking and reload recovery with ordinary
mutations, while preserving the explicitly captured generation revision. An
unchanged authoritative context avoids another calendar read; reconciliation
that advances the revision reloads it. A missing owner draft is created only on
explicit confirmation, then the known resulting revision is captured and the
reviewed source facts are compared before confirmation. Stale writes are never retried.

## Persistence

`duty_allocations` holds one snapshot per owner/draft or publication, using the
existing NULL-publication convention. It stores the original ordinary baseline,
confirmed half-unit targets, repayment references, ordered counterpart transfers,
explicit primary locks, rule-specific approvals, captured accounting/calendar
fingerprints, generation seed/metrics and publication ancestry. Only managers can
read it; clients cannot write it. Calendar snapshots do not include this table.

`duty_assignments.locked` persists a primary lock even before the first allocation.
The duty editor saves it atomically with the primary through `duty_save_schedule`;
its optional `lock_edits` date list explicitly reviews the edited duty (both days
for a weekend). Other writes still cannot remove or change locked work silently.
Generation facts derive locks from the owned current duty rows, and schedule saves
keep allocation lock metadata synchronized. Changing/unlocking a primary retires
only approvals referring to the changed lock; an override boolean never grants a
solver exception. Existing generation validation continues to reject conflicting
locks, target floors and missing exact approvals. The Generate popup no longer
edits locks or exceptions. Published/history copies retain duty lock flags.

The additive `20261028204239_duty_editor_locks.sql` migration backfills flags from
existing allocation locks without rewriting duty identities or primary/history
data. Apply it through the normal database-first release process before the UI;
this feature does not authorize hosted changes.

Publish freezes the snapshot alongside the owned duties in the same transaction.
Restore copies it into the draft. Cancel Draft deletes only its working snapshot.
Deleting the last version first preserves its working snapshot. Approved swaps
copy history, update affected lock identities and retain unrelated approvals;
changed approval scopes require review before later generation/publication.
Swaps account authoritative workload changes without enforcing old solver targets.

## Checked RPC contracts

All three public invoker wrappers call checked implementations with an empty
search path, manager authorization before and after the existing workspace lock,
and the explicitly captured `p_revision`. Private helpers are not client-callable.

* `duty_generation_context(p_month, p_revision)` reconciles earned contributions
  at post-lock server time and returns revision, fingerprints, operational opening,
  generation eligibility, canonical duties/weights, participation/seniority,
  availability kinds, secondaries, locks/approvals, confirmed allocation, actual
  accounting and a separate projection through opening. No availability notes are
  returned. Neighbor guards include both current publications and open working
  drafts of the preceding/following owner, including Friday-owned boundary work.
* `duty_confirm_allocation(p_month, p_allocation, p_locks, p_approvals,
  p_revision, p_fingerprint)` persists explicitly reviewed input for an open draft.
  It independently checks denomination, membership, nominal totals, actual source
  claims, exclusive source intervals, counterpart conservation, locked floors and
  exact exception scopes. An independent canonical-weight partition search verifies
  minimum ordinary squared cost; the baseline cannot be inflated to manufacture
  creditor relief or changed later while the calendar/participants remain unchanged.
  Manager target deviations require explicit temporary/permanent counterparts.
* `duty_save_generation(p_month, p_assignments, p_revision, p_fingerprint,
  p_seed)` accepts only a primary-assignment map and preserved secondaries. It
  independently verifies every scheduling invariant and allocation budget. It
  accepts valid partial drafts without changing confirmed numbers. Server time is
  sampled after locking and immediately before mutation; equality with canonical
  opening rejects the result atomically. Partial coverage never bypasses Publish.

`lib/supabase/generation.ts` converts the authoritative response to the pure
scheduling/allocation contracts, replays accounting, and preserves the captured
revision/fingerprint on writes. These operations are excluded from the generic
workspace mutation API so it cannot silently substitute a newer revision.
The existing read-only inspection guard applies, including context reconciliation.

## Accounting and lineage

The server compiles allocation tokens from the saved baseline, real unreserved
claims and ordered transfers. Drafts post no discretionary ledger events. Publish
binds compiled routes and repayments to disjoint real primary duty capacity, then
uses the existing authoritative transition/normalization/reservation validator.
A temporary A→B followed by permanent B→C charges A→B once, funded by C's work.
Deferral retains the original source path and uses its available normalized suffix
for retained repayment. Reverse burdens reserve existing obligations instead of
netting them away before completion. Secondary coverage contributes no capacity.

Copied intent IDs never create another origin. Still-live unchanged reservations
retain their IDs; restored or rearranged still-outstanding repayment can rebind
using fresh IDs and the retained source publication. Completed sources are never
reserved again. A stale, corrected, held, externally reserved or unfunded source
requires explicit refresh/review; targets are not silently changed. Approved swaps
retain the existing cancellation/rerouting accounting instead of forcing repayment
onto replacement work. Ledger snapshots survive publication deletion.

Changing allocation transfer provenance over an existing publication requires
lineage review. The checked boundary deliberately refuses to create fresh baseline
origins over already-published work; authoritative physical replacements and the
existing audited manual accounting operations remain available. Compound reverse
routes and ambiguous normalized deferrals likewise require review.

Baseline validation is an exact decision over owned canonical weights,
independent of the scheduling solver and its proofs. `allocation_fit` searches
remaining duty-count vectors, so identical duties are never re-explored: lumpy
12-engineer special months that took 8–60+ s in the original per-duty search now
take milliseconds. Outside its exact integer domain (a non-positive weight, over 64
duties, or n·total ≥ 2²⁵) the original search still decides. Database
transaction/statement limits must fail the whole request rather than accept an
unverified baseline. `supabase/tests/baseline-fit.mjs` checks both searches against
an independent exhaustive oracle on small and realistic weight sets.

## Disposable local validation

Use the pinned CLI and database-only LOCAL setup in [Supabase setup](SUPABASE_SETUP.md).
Never pass a linked target or hosted connection string.

```sh
node scripts/database-baseline.mjs --verify-local supabase_db_duty-scheduler
node supabase/tests/generation.mjs supabase_db_duty-scheduler
node supabase/tests/baseline-fit.mjs supabase_db_duty-scheduler
node supabase/tests/generation-races.mjs supabase_db_duty-scheduler
node supabase/tests/compensation-parity.mjs supabase_db_duty-scheduler
```

The generation fixture rolls back every synthetic case. It covers authorization,
malformed/stale inputs, independent schedule/ordinary-baseline checks, scoped locks,
rollback during publication, partial drafts, cutoff, copied/deleted lineage,
exclusive source budgets, routed publication and exact TypeScript replay. Separate
sessions exercise competing saves, demotion and cutoff during real lock waits.
The existing fresh/upgrade, security, swap and compensation tests remain required;
`scripts/database-upgrade.mjs` checks populated upgrade preservation and disposable
logical backup/restore against the exact base. These tests do not activate the UI
or establish hosted release readiness.
