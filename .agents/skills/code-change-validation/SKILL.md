---
name: code-change-validation
description: "Select and run focused validation for a Duty code or configuration change, or review its diff; skip prose-only edits."
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
   - Before a requested PR: run the checks in `.github/workflows/quality.yml` once
     on the final diff. CI has no database credentials and makes no AI calls.
3. For security-sensitive changes, use security-review. The root routing policy
   decides delegation; this skill never spawns an agent itself.
4. Run independent checks together when they cannot interfere. Keep full logs
   outside tracked files; inspect bounded failure output. Fix regressions in scope,
   then rerun affected checks. Do not suppress or weaken failures.
5. Review the final diff for behavior, permissions, data loss and unrelated edits.
   Report checks/results, baseline failures, missing environment and remaining risk.
   Review-only agents do not change files or rerun supplied successful checks.
