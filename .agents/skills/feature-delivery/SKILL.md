---
name: feature-delivery
description: "Deliver a Duty feature through a PR when the user explicitly authorizes end-to-end Git delivery; ordinary implementation does not authorize commit or push."
---

1. Confirm base and Git authorization. Inspect status, preserve changes and fetch
   the intended base; reuse an existing matching branch safely.
2. Implement the smallest coherent feature following AGENTS.md and existing
   architecture. Use code-change-validation and relevant specialized skills;
   follow root routing for meaningful bounded risk reviews.
3. For every UI change with screenshot differences, automatically prepare visual
   review without reminders. The primary agent inspects BEFORE/AFTER/DIFFERENCE
   and overlays, explains intended component changes/suspected regressions, and
   links the current Quality `visual-review` artifact in the authorized PR
   description (or one concise authorized comment), listing exact paths/hashes.
   Keep CI read-only; use existing primary-agent PR authorization, not elevated
   credentials for PR code. Do not create an unnecessary subagent.
   NEVER write references before explicit user approval of those images/paths.
   Finish review preparation and other authorized checks before waiting. Earlier
   design approval excludes later candidate changes. After approval, verify
   before/candidate hashes, copy only approved references, rerun affected visuals,
   and continue authorized commit/push/final Quality without repeated permission
   questions. Record approval scope, hashes, source/review and pre-update commits.
   Preserve evidence through approval/verification; record approval in the PR.
   After successful approved validation, automatically remove task-created local
   galleries, comparison screenshots, recordings, manifests and reports. Audit
   accidentally tracked temporaries and remove where appropriate. Verify targets
   stay within the workspace; preserve user/unrelated files, test/reproducibility
   inputs, permanent generators, CI integration and approved baselines. Never
   manually delete GitHub Actions artifacts; let retention expire them.
4. Stage only intended changes, excluding credentials/local settings. When
   authorized, commit/push and create/update the intended PR. Wait for exact-head
   Quality; diagnose failures and rerun only affected checks. Reuse successes for
   unchanged inputs. Correct regressions without suppressing checks. If strict
   visual failures await approval, report the artifact and exact pending scope;
   do not update references or claim merge readiness. Report blocked operations
   and preserve completed work.
5. Report PR, commit, checks, risks and concrete follow-up. Require green final
   Quality before declaring ready to merge. Never merge, deploy, alter production
   settings, migrate hosted databases or rewrite history without separate explicit
   authorization. Git authorization does not extend to unrelated future tasks.
