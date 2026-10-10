---
name: scheduling-regression
description: "Verify Duty scheduling changes to generation, points, weekends, constraints or month ownership; skip unrelated UI and documentation edits."
---

# Scheduling regression

1. Read the changed scheduling path and the relevant README scheduling rules.
   Use `tests/engine.test.mjs` for engine behavior and `tests/snapshot.test.mjs`
   for storage round trips; inspect only affected helpers initially.
2. Map the change to the relevant invariants: coverage/unavailability, weekend
   ownership/caps, point conservation, month boundaries, emergency cover,
   publication or monthly fairness. Do not invent stricter fairness guarantees.
3. Add a minimal failing regression when implementing a fix. Use explicit fixed
   seeds for generation; use a small fixed seed set if variability matters.
   Prefer invariant assertions over an exact heuristic schedule. Never replace
   production randomness or relax an assertion merely to make a test pass.
4. Run `node --test tests/engine.test.mjs`; include snapshot tests when assignments
   or serialization change. Reuse already-completed checks for this diff.
   A reviewer reports missing coverage to the primary agent instead of editing.
5. Return checked invariants, commands/results and uncovered edge cases. Database
   access and real browser behavior require separate checks; do not imply coverage.
