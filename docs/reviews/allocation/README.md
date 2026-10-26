# Allocation UI review

Reviewed locally on 24–25 October 2026, starting from `develop` `55d44c6`.
Synthetic intercepted auth/RPCs, production Next build, real allocation and HiGHS
Workers, self-hosted WASM. No hosted database or deployment was used.

The design reuses Duty's green panels, team colors and native typography. One
Radix popup contains the summary, engineer controls, counterpart explanations,
compensation projection and reasoned lock scopes. A compact desktop table becomes
stacked cards on phones; the action footer always remains visible. Numeric controls
retain a predictable minus/value/plus order inside Hebrew RTL. Keyboard dismissal
returns focus to Generate; pending writes prevent duplicate submissions.

Reviewed captures (review evidence, not new or updated visual baselines):

- [Desktop English, 1440 × 1000](allocation-en-1440.png)
- [Phone English, 375 × 812](allocation-en-375.png)
- [Narrow phone Hebrew, 320 × 812](allocation-he-320.png)

Every allocation row and dialog had `scrollWidth === clientWidth`. At 320px, the
dialog's content width was 294px, cards 260px, and the action footer ended at
786.63px within the 812px viewport. Tests also scroll to the end and verify the
footer remains visible. [Raw layout and timing evidence](measurements.json).

One local Windows Chromium sample per desktop/mobile context, with two test
workers, including initialization, domain work, intercepted RPCs and UI feedback:

| Engineers | Proposal | Confirm, generate, compile and save |
|---|---|---|
| 12 | 1.47–1.60 s | 2.63–3.23 s |
| 24 | 5.13–5.72 s | 1.72–1.76 s |

These are desktop hardware measurements under mobile emulation, not iPhone
performance claims. Production search budgets are 15 seconds for proposals, five
for edits/checks and 30 for generation; cancellation terminates synchronous WASM.

Validation:

- 170 focused Node checks passed before the final seed fix; 65 affected solver,
  allocation and binding checks passed afterward, plus seven allocation-review
  regressions, including JSONB scope reordering. Type checking, affected ESLint
  and the production build/CSS verification passed. The existing unused `locked`
  destructuring warning in the legacy engine remains.
- 52 allocation/real-Worker/auth-lifecycle browser cases passed in desktop and
  mobile contexts. The 44 existing baseline/editor cases also passed. Coverage
  includes temporary/permanent/half-step controls, pending edits, undo, UNKNOWN,
  partials, cancellation, asset failure/restart, stale saves, cutoff while open
  and at save equality, missing owner drafts, scoped approval/reload, emergency
  preservation, narrow Hebrew layout, focus and 12/24-engineer timings.
- Disposable `supabase_db_duty-scheduler` generation, concurrency and compensation
  parity suites passed: 350 exhaustive baseline cases, 71 SQL/core histories,
  20 graph comparisons, authority after lock waits and cutoff equality. No schema
  or migration changes were needed. A bounded QA review found no blocking issues.

Remaining boundaries: physical iPhone Safari validation remains a release gate.
The existing Special Block editor stays owner-scoped. Changed transfer provenance
over published history and ambiguous/unavailable compensation sources continue
to require explicit review under PR #37's checked contracts. Search proof details
are shown for the current run; PR #37 persists its checked metrics and seed.
No visual references were replaced. CI was not inspected; required Quality and
release gates still apply. No merge or deployment is authorized.
