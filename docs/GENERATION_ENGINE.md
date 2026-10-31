# Isolated domain generation engine

`lib/scheduling/index.ts` is the reusable TypeScript entry point for the generation
part of [the specification](GENERATE_ALGORITHM.md). Application Generate now uses
this engine after explicit allocation confirmation. The pure engine remains
independent of UI, storage and authorization; the application uses the checked
[database boundary](ALLOCATION_DATABASE.md).

## Inputs and execution

`GenerationInput` contains one owner month, an opaque authoritative source
revision, calendar specials/splits/marked dates, known member identities and
explicit active/approved/eligible status, confirmed targets **in points**, date
constraints, locks, secondary identities, neighboring commitments, scoped
approvals with reasons and the optional rotation maps `weekendRotation` (weekend
turns per member) and `weekdayRotation` (five Sunday–Thursday counts per member),
both derived from published months by `rotation.ts`; the application builds them
from the workspace snapshot with `publishedHistory`.
Every participating member needs a target, including zero.
Targets must sum to the weight of all required owned duties. Invalid half steps,
special ranges/weights, identities, fixed conflicts and lock floors are errors.
Unavailable or globally unattainable allocations remain valid partial problems.

The calendar builder owns the entire required coverage; callers cannot supply a
subset of duties to evade coverage or the opening cutoff. Friday owns both halves
of a weekend, including a split Saturday in the next month/year. A special range
touching a weekend keeps it combined as one holiday weekend; every holiday date
adds its own extra (weekday 2 + 2·extra units, Friday or Saturday 1 + 2·extra), so
the combined duty weighs the sum of its two dates and reports the Saturday's own
units as `saturdayUnits` for accounting. Only an explicit split separates the
halves, each keeping its own date's units, so splitting never changes the
weekend's total. Marked holiday
dates affect coverage priority without changing structure or weight. Overlapping
special ranges are rejected. All internal weights, targets and deficits are integer
half-point units; divide by two for display. No physical duty is divided by the solver.

```ts
import loadHighs from 'highs';
import {
  createHighsAdapter, createGenerationRequest, solveGeneration, acceptGeneration,
  type GenerationInput,
} from './lib/scheduling/index.ts';

// Build input from authoritative, confirmed source facts in the database adapter.
declare const input: GenerationInput;
const adapter = await createHighsAdapter(loadHighs);
const request = createGenerationRequest(input, {now: Date.now()});
const result = solveGeneration(adapter, request);
acceptGeneration(result, input, Date.now());
```

`solveGeneration` is synchronous and is intended for Node tooling or a Worker,
never the browser main thread. `createGenerationWorker()` supplies the browser
wrapper: `await worker.run(input, {seed?, seconds?, nodes?}, onProgress?)` and
`worker.terminate()`. Termination rejects the pending request and discards its
result; create a new wrapper afterward. A busy wrapper rejects concurrent requests.
Progress exposes duty IDs, engineer IDs, independently checked assignments,
metrics and the proved objective prefix. It is provisional, not accepted data.

Production Workers load `/api/scheduling/asset/highs.mjs` and `highs.wasm` from the
lockfile-pinned package. The route allowlists only those files and LICENSE, sets
explicit MIME types, nosniff and same-origin resource policy, and is included in
Next's deployment tracing. It needs no diagnostic flag, CDN, SharedArrayBuffer or
cross-origin isolation. The separate spike route remains opt-in under
`DUTY_SOLVER_SPIKE=1`; its imports are compatibility facades over the shared solver.

`createGenerationRequest` clones source facts and draws a fresh cryptographic
31-bit seed when none is supplied. Pure conversion, validation and solver code
receive explicit values. Requests record source identity, core/model versions,
seed, time and node limits. Results additionally record the actual embedded
HiGHS version, every stage's status/objective/bound and the independently verified
objective vector. Preserve the original input snapshot alongside this metadata
for reproduction. Stable fact ordering supports equivalent input permutations.
A wall-clock-limited unfinished search does not promise identical incumbents;
use the recorded seed, node budget, package/runtime/environment and sufficient
time for deterministic completed replay.

Model `highs-leximin-v5` adds the cross-month weekday rotation level to the
verified metrics and moves the sorted-gap leximin below the seed, where it only
breaks ties: above the seed (v4) it pushed every pair towards fourteen days, so
consecutive months repeated the same weekday pattern. v4 had added the weekend
rotation, preferred-date and same-weekday levels and placed rotation and weekday
variety directly below the proved minimum gap (v3 had them below the full gap
vector, where they were nearly inert). The seeded tie coefficients come from a
32-bit hash mixer instead of a linear congruential generator, whose low bits
alternated with each draw. Coefficients stay below 1,000: million-scale
coefficients caused native floating-point objective drift on a six-engineer
emergency-cover fixture, despite exact valid binary assignments. Smaller scores
preserve the priority hierarchy and strict integer/objective checks; seed
reproduction must use the recorded model version.

## Constraints, objectives and acceptance

Automatic primaries respect covered-date availability, eligibility, identity
exclusion, target ceilings, consecutive duties and one distinct weekend per
owner month. Secondary coverage is preserved and contributes no primary points,
weekends or gaps. Existing unavailable/inactive secondary members are flagged
for separate publication review; unknown identities are structural errors.

Availability approval covers exactly the locked duty's unavailable dates.
Consecutive approval covers an identified pair of locks. Boundary approval
acknowledges the selected lock and the exact neighboring commitment. Additional
weekend approval names exactly the engineer's reviewed locked weekend identities;
it permits no third automatic weekend. There is no generic override flag.

The source adapter supplies **both** current live publications and
existing working commitments from neighboring owners, including actual cross-month
intervals. Historical versions must be excluded. The engine unions/deduplicates
owner/interval/primary facts while retaining source labels, guards every binding
interval and measures gaps against the nearest preceding/following intervals.
Neighbors are constants, never returned as writable selected-month assignments.

Optimization uses one optional-coverage MILP. It proves and fixes each priority
before advancing: covered dates, marked special dates, assigned point units,
maximum minimum elapsed gap, weekend rotation cost, same-weekday repeats,
cross-month weekday rotation cost, preferred date count, a seeded integer tie
objective, then the full sorted-gap leximin as a tie-breaker. The order below
the minimum gap is fixed in one place (the `quality` list in `solver/model.ts`).
A combined weekend counts two dates. Missing gaps are padded with infinity;
external-only pairs are omitted. Approved locked zero gaps remain in the
objective. There is no average-gap or weighted-priority shortcut. Threshold/clique
search, exact capacity cuts and continuous successor flows reuse the foundation
from PR #31, with one disposable native model per run. The rotation costs reuse
the weekend OR columns and the assignment columns; repeat counters are continuous
columns added only once spacing is proved. A nonnegative level whose incumbent is
already zero is fixed by identity without a native solve. The independent
validator recomputes the rotation, repeat, weekday-rotation and preferred facts
from source dates, constraints and the rotation maps.

The default and maximum domain search budget is 30 seconds across all stages,
including model construction. Solving stops early when finished. WASM loading,
source conversion and final domain validation add overhead outside that search
timer; the transport also has a load/runtime watchdog. An interrupted or limited
search keeps only the verified incumbent and honest proof prefix. Optional-model
infeasibility contradicting that incumbent is a runtime/model error, not ordinary
complete infeasibility. Structured diagnostics distinguish facts, demonstrated
capacity/combination shortages and unproved complete feasibility. They do not
claim a unique minimal explanation for every globally infeasible allocation.

`validateGeneration(input, assignments)` independently recomputes domain rules,
coverage, point conservation and successor gaps without MILP rows/variables or
normalized eligibility. Every returned result and progress assignment passes this
domain check as well as the solver's independent integer validator. Results keep
completeness, complete feasibility, termination and objective proof separate.
Uncovered owned dates and each engineer's target/locked/assigned/missing units
remain explicit.

09:00 handovers are converted separately in `Asia/Jerusalem`; a duty can last
23 or 25 hours. `coverageStart` is the earliest required **owned** duty start,
even with no assignments. If the month starts Saturday, opening is Sunday the
2nd at 09:00. Requests reject `now >= coverageStart`; the Worker rechecks on
return. Synchronous callers must invoke `acceptGeneration` with authoritative
current inputs/time immediately before acceptance. It rejects changed source
facts, late results and accidental mutation of returned assignments/metadata.
Snapshot keys are exact canonical serializations for consistency, not security
tokens. The checked database save enforces authoritative time, revisions,
permissions, identities and independent validation transactionally; none of
those database guarantees can be replaced by client proof metadata.

## Verification and measured performance

Focused checks:

```sh
node --test tests/generation.test.mjs tests/highs-spike.test.mjs tests/rotation.test.mjs tests/engine.test.mjs tests/snapshot.test.mjs
pnpm exec tsc --noEmit
pnpm exec eslint lib/scheduling lib/solver-spike tests/generation.test.mjs tests/rotation.test.mjs tests/fixtures/generation.mjs scripts/benchmark-generation.mjs
pnpm build
pnpm exec playwright test tests/browser/solver-spike.spec.ts --workers=1
node scripts/benchmark-generation.mjs --seconds=30 --repeat=3 --scenarios=normal,availability,weighted,locked,boundary,tight,shared-shortage,small-team,larger-team,rotation,weekday-rotation --output=docs/benchmarks/generation-2026-10-31-v5.jsonl
```

Regression coverage includes real 12-engineer months, three years of owned
coverage, cross-year combined/split specials, leap day, DST, shared capacity,
availability/lock scope, fixed zero gaps, weekend shortages, emergency identity,
both boundary sources, stale/late/altered results, Worker cancellation/restart,
automatic seeds, deterministic completed replay, weekend and weekday rotation
state from published months, the rotation, weekday and weekday-rotation levels
against the exhaustive oracle, seed variety of assignments and gap patterns
across a whole ordinary month, and a simulated sequence of generated months in
which every member covers all five weekdays within one cycle. An independent
exhaustive oracle checks small real-month scenarios against the quality vector
(coverage, special, units, minimum gap, rotation, repeats, weekday rotation,
preferred); the retained solver tests, which run without seeded ties, also
enumerate the full leximin on varied weighted, partial, boundary and
fixed-exception instances.
Existing application engine and snapshot regressions still exercise the legacy behavior.

Recorded Node 23 / Windows x64 / Intel i9-10900KF results for model v5 (three
sequential runs per scenario, one fresh WASM instance per scenario; node limit
1,000,000, seed 17; the first run of each scenario includes JIT warm-up), with the
v4 range of the same day for comparison:

| Scenario | Engineers | v5 end-to-end | v4 end-to-end | Outcome |
|---|---:|---:|---:|---|
| Ordinary | 12 | 1.11–1.52 s | 1.42–3.73 s | Complete, all objectives proved, 0 repeats |
| Availability/preferences | 12 | 0.96–1.02 s | 1.11–1.16 s | Complete, all objectives proved |
| Weighted specials and splits | 12 | 1.25–1.32 s | 1.27–1.29 s | Complete, all objectives proved |
| Locks | 12 | 0.84–0.88 s | 0.85–0.90 s | Complete, all objectives proved |
| Live/working boundaries | 12 | 1.87–2.14 s | 2.61–2.76 s | Complete, all objectives proved, 0 repeats |
| Tight availability | 12 | 0.14–0.15 s | 0.16–0.20 s | Complete, all objectives proved |
| Shared opportunity shortage | 12 | 1.11–1.14 s | 1.92–2.22 s | Optimal partial, 27/30 dates |
| Five weekends, small team | 2 | 0.15 s | 0.15–0.16 s | Optimal partial, 25/31 dates (11 unavoidable repeats) |
| Larger team | 24 | 0.36–0.38 s | 0.38–0.41 s | Complete, all objectives proved |
| Weekend rotation state | 12 | 6.29–6.67 s | 1.09–1.25 s | Complete, all objectives proved; one turn forced by the minimum gap |
| Weekday rotation state | 12 | 1.80–2.18 s | — | Complete, all objectives proved; one covered weekday forced |

Below the seed the gap-count stages only confirm the incumbent, so most fixtures
got faster (their LP relaxations are pinned by the fixed seed row). The weekend
rotation fixture is the exception: its twelve-day count stage spends about three
seconds at the LP root with the dense seed equality present, all stages still
prove, and the total stays well inside the 30-second budget. The seed now varies
the gap pattern: on the ordinary month twelve seeds give twelve different sorted
gap vectors at the same eleven-day minimum with no repeat, where v4 gave
`[11,11,12,12,12×5,14,14,14,14,15]` days for every seed. Raw inputs are
reproducible through `tests/fixtures/generation.mjs`; hashes, settings, stage
proofs and measurements are in the [v5 benchmark record](benchmarks/generation-2026-10-31-v5.jsonl)
(the [v4](benchmarks/generation-2026-10-31.jsonl) and [v2](benchmarks/generation-2026-10-24.jsonl)
records are kept). Every sample passed
independent domain validation and disposed its native model. WASM linear memory
ranged from about 20 to 61 MiB and stayed constant across each scenario's warm
repeats. End-to-end measurements include conversion/final validation but exclude
WASM initialization (recorded separately). These local desktop cases are not a
worst-case guarantee or a mobile performance claim. Real iPhone Safari validation,
including WASM loading, cancellation and responsiveness, remains a release
requirement. UI, persistence, compensation and authoritative server enforcement
are integrated separately; these desktop measurements alone do not establish release readiness.
