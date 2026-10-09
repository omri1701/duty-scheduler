---
name: feature-delivery
description: "Deliver a Duty feature through a PR when the user explicitly authorizes end-to-end Git delivery; ordinary implementation does not authorize commit or push."
---

1. Confirm the requested base and Git write authorization from the session. Inspect
   status, preserve unrelated changes, fetch that base and start the requested feature
   branch from its latest commit. Reuse an existing matching branch safely.
2. Implement the smallest complete feature following AGENTS.md and existing architecture.
   Use code-change-validation and relevant specialized skills; reuse their results.
   Follow root routing for bounded reviewers when distinct scheduling/security risks justify them.
3. Review the final diff and pass focused tests and the project's PR quality gates.
   Stage only intended files, excluding local settings, credentials and unrelated changes.
4. When authorized, make meaningful commits, push the feature branch and open a PR
   against the requested base. Check available CI and correct introduced failures.
   If an external operation is blocked, report it and retain completed local work.
5. Report PR URL, commit, validation, review results and concrete manual follow-up.
   Never merge, deploy, change production settings or apply remote migrations without
   separate explicit authorization. Do not infer Git write permission on future tasks.
