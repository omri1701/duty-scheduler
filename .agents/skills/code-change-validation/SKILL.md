---
name: code-change-validation
description: "Select focused validation for Duty code/config changes, diff reviews or authorized PR delivery; skip prose-only edits without delivery."
---

# Code-change validation

1. Inspect status, scoped diff and new files. Preserve changes; use the supplied
   comparison base. Reuse context and successful checks.
2. Select affected checks:
   - Scheduling: scheduling-regression.
   - Gestures: `node --test tests/gesture.test.mjs` and relevant browser checks.
   - Snapshot conversion: `node --test tests/snapshot.test.mjs`.
   - TypeScript: `pnpm exec tsc --noEmit`; lint changed code.
   - Runtime/build configuration: `pnpm build`.
   - AI configuration: `python3 scripts/validate-ai-config.py`.
   - CI/release: `node --test tests/quality.test.mjs tests/release.test.mjs`;
     validate workflow syntax and executable changes. Database harness changes
     also require disposable SQL checks.
   - Prose alone: skip app builds. Every PR requires exact-head Quality;
     strict docs/AI PRs skip app/database jobs, branch/manual runs execute everything.
3. For every authorized UI change, automatically run relevant visual tests;
   retain the custom reporter. It generates `work/visual-review/index.html` and
   `manifest.json`; Quality uploads `visual-review` even after comparison failures.
   Reuse unchanged evidence instead of repeating suites for gallery preparation.
   Inspect every changed/missing reference and retry difference on relevant
   Linux/Windows platforms. Fix regressions; explain intended component changes
   and suspicious differences. Present BEFORE/AFTER/DIFFERENCE/overlay, grouped
   by project, viewport/language, with exact paths and candidate hashes.
   Automatically link the current CI artifact in the authorized PR description
   (or one concise authorized comment), with assessment and commit identity.
   Users extract the ZIP/open index.html; retain a local fallback.
   NEVER update references without explicit user approval of presented paths/images.
   Complete preparation, list approval scope, then wait. Earlier design approval
   excludes later image changes; investigate flakes instead of approving them.
   After approval, verify before/candidate hashes, copy ONLY approved candidates,
   record approval/paths/hashes/source commit, rerun affected visuals and final
   Quality automatically. New differences return to review. Never blanket-update
   unapproved references or loosen tolerances.
4. Follow root security-review routing. Parallelize independent checks; preserve
   logs/exit codes, diagnose failures, rerun only affected checks. Review final
   correctness, permissions, data loss, missing tests and unrelated edits. Report
   actual results, pending approval and limitations honestly.
