---
name: code-change-validation
description: "Select focused validation for Duty code/config changes, diff reviews or authorized PR delivery; skip prose-only edits without delivery."
---

# Code-change validation

1. Inspect `git status --short` and the scoped diff, including new files. Use the
   explicitly supplied base for PR reviews; do not assume a branch or fetch all
   history. Read README/package commands only if not already in context.
2. Select checks by affected behavior:
   - Scheduling: use scheduling-regression and reuse its results.
   - Gestures: `node --test tests/gesture.test.mjs` plus a relevant browser check.
   - Snapshot conversion: `node --test tests/snapshot.test.mjs`.
   - TypeScript: `pnpm exec tsc --noEmit`; lint changed code with the existing ESLint.
   - Runtime, dependency or build configuration: `pnpm build`.
   - AI configuration: `python3 scripts/validate-ai-config.py` (Python 3.11+).
   - Documentation/AI infrastructure alone: validate affected instructions/metadata;
     test changed validator logic or executable CI configuration as relevant. Skip
     local application tests/builds when application code/config is unchanged.
   - Before an application PR: run `.github/workflows/quality.yml` checks once on
     the final diff, reusing completed checks. For every PR verify Quality CI on the
     final head; CI has no database credentials and makes no AI calls.
3. For security-sensitive changes, use security-review. The root routing policy
   decides delegation; this skill never spawns an agent itself.
4. Run independent checks together when they cannot interfere. Keep full logs
   outside tracked files; inspect bounded failure output. Fix regressions in scope,
   then rerun affected checks. Do not suppress or weaken failures.
5. Review the final diff for behavior, permissions, data loss and unrelated edits.
   Report checks/results, baseline failures, missing environment and remaining risk.
   Review-only agents do not change files or rerun supplied successful checks.
