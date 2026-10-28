---
name: scheduling-regression
description: "Verify changes to generation, points, weekends, constraints or month ownership; skip unrelated UI and docs."
---

Map the changed path to relevant README invariants: coverage/unavailability,
weekend ownership/caps, point conservation, month boundaries, emergency cover,
publication and monthly fairness. Do not invent stricter fairness guarantees.

For fixes, reproduce the failure in a small regression where practical. Use fixed
generation seeds and invariant assertions rather than exact heuristic schedules;
use a small seed set when variability matters. Preserve production randomness.

Run affected cases in `tests/engine.test.mjs` first; run the full engine file when
shared generation logic or invariants are affected. Include
`tests/snapshot.test.mjs` when assignments or serialization change. Add focused
browser or real database checks when the changed behavior crosses those boundaries.
