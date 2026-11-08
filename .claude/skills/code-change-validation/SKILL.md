---
name: code-change-validation
description: "Choose focused checks for Duty code/config edits, diff reviews or authorized PR delivery."
---

Select checks from the affected behavior; do not run the full application suite
merely because a PR is requested:

- Scheduling: scheduling-regression.
- Gestures: `node --test tests/gesture.test.mjs` and relevant browser checks.
- Snapshot conversion: `node --test tests/snapshot.test.mjs`.
- TypeScript: `pnpm exec tsc --noEmit`; lint affected code.
- Runtime/build configuration: `pnpm build`.
- AI configuration: `python3 scripts/validate-ai-config.py` (Python 3.11+).
- CI/release: `node --test tests/quality.test.mjs tests/release.test.mjs` and
  workflow syntax/executable checks; disposable SQL checks for database harnesses.
- Prose/AI-only edits: no application build or tests.

For UI changes, run relevant browser/visual tests with the existing reporter.
Use `pnpm test:e2e:ci` after building when broad browser coverage is warranted.
Inspect relevant differences or failures; prepare BEFORE/AFTER/DIFFERENCE images,
overlays or the existing `work/visual-review/index.html` only when needed to assess
or approve changes. No exhaustive gallery review or CI artifact processing by default.
Gesture simulations do not establish real-device correctness.

Never update visual references without explicit user approval of the presented
images and exact paths. Earlier design approval excludes later differences.
Verify approved baseline/candidate hashes, update only approved paths, record
approval evidence in the PR and rerun affected visuals. Never loosen tolerances
or hide regressions.
After successful validation, remove only owned temporary review outputs; preserve
approval evidence, reproducibility inputs and permanent baselines/tooling.

Review the final diff for correctness, permissions, data loss, missing regressions
and unrelated edits.
