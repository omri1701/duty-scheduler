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
   Reuse unchanged evidence. Inspect changed/missing references and retry differences
   on relevant Linux/Windows platforms. Fix regressions; explain intended/suspicious
   differences. Present BEFORE/AFTER/DIFFERENCE/overlay by project, viewport/language,
   with exact paths and candidate hashes.
   Automatically link the current CI artifact in the authorized PR description
   (or one concise authorized comment), with assessment and commit identity.
   Users extract the ZIP/open index.html; retain a local fallback.
   NEVER update references without explicit user approval of presented paths/images.
   Prepare review, list scope, then wait. Earlier approval excludes later changes;
   investigate flakes.
   After approval, verify before/candidate hashes, copy ONLY approved candidates,
   record approval/paths/hashes/source commit, rerun affected visuals and final
   Quality automatically. New differences return to review. Never blanket-update
   unapproved references or loosen tolerances.
   After approval and successful validation, automatically delete task-created
   local galleries, comparison screenshots, recordings, manifests and reports;
   audit/remove accidentally tracked temporaries. Verify cleanup targets stay
   within the workspace. Preserve user/unrelated files, test/reproducibility
   inputs, permanent generators, CI integration and approved baselines. Record
   approval evidence in the PR before cleanup. Never manually delete GitHub
   Actions artifacts; retention handles expiration.
4. Follow root security-review routing. Parallelize independent checks; preserve
   logs/exit codes, diagnose failures and rerun affected checks. Review correctness,
   permissions, data loss, missing tests/unrelated edits. Report results,
   pending approval and limitations honestly.
