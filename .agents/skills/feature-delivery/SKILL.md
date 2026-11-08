---
name: feature-delivery
description: "Deliver an explicitly authorized commit, push and PR; ordinary implementation does not authorize Git delivery."
---

Confirm the intended base, fetch it and create or reuse a matching branch without
disturbing existing work. Implement and use code-change-validation before delivery.
Stage only the intended diff, excluding credentials, local settings and temporary
review artifacts.

Commit, push and create/update the PR against the intended base using existing
authorized Git credentials or connectors. Describe the resulting behavior, local
checks and remaining limitations. Include visual approval evidence only when
baselines changed. If an operation is blocked, preserve completed work and report
the exact manual step.

Return the PR link and a brief result, then STOP. No CI polling, waiting, run/log
inspection or artifact retrieval; handle CI results only when the user supplies
them or explicitly asks to check CI (one `gh pr checks` read, per AGENTS.md).
Required checks still gate merging.
