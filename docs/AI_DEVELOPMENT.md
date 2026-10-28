# AI development

## Setup and effective settings

Open this repository in IntelliJ's Codex integration and review/trust its project
configuration. Authentication is a manual setup step: use an existing ChatGPT
session or sign in yourself if needed. Restart the Codex session after pulling
instruction/config changes. Future prompts need only the task and its specific
requirements; [AGENTS.md](../AGENTS.md) owns the universal working rules.

`.codex/config.toml` retains `gpt-6.1-sol` with `low` reasoning as the economical
default. Select higher effort in the client for work that needs deeper reasoning;
explicit task/client settings take precedence. Markdown cannot switch the running
primary model. `forced_login_method = "chatgpt"` restricts local Codex authentication
to ChatGPT; no API key, external provider, AI SDK or AI CI calls are needed.

Project settings load only for trusted projects. IDE launch options and managed
settings can override them; verify the effective settings in the installed client.
Model/account availability is not established by this repository. If configured
reviewers are unavailable, perform the focused review locally and report the gap.
ChatGPT's GitHub connector and shell Git credentials are separate connections;
use whichever is already authorized, otherwise report the manual setup step.

## Where specialized instructions live

Skill descriptions are discovered initially; bodies load only when relevant.

| Existing skill | Specialized knowledge |
| --- | --- |
| `code-change-validation` | Check selection and visual baseline approval |
| `scheduling-regression` | Scheduling invariants and deterministic regressions |
| `security-review` | Auth/database checks, migrations and release trust boundaries |
| `feature-delivery` | Authorized branch/commit/push/PR workflow |

The existing `qa` (`gpt-6-luna` / `high`) and `security` (`gpt-6.1-sol` / `high`)
agents are optional reviewers under the root delegation rule. Enabling agents
does not require using them; concurrency is capped at one child, excluding the
primary. Reviewer files retain `sandbox_mode = "read-only"` conservatively, but
current custom-agent documentation says sandbox settings do not override parent
permissions. Their no-edit instruction is explicit, not a separate sandbox guarantee.

## Claude Code

Claude Code runs alongside Codex. `CLAUDE.md` imports AGENTS.md, so both share one
rule set. `.claude/skills/` mirrors `.agents/skills/` byte for byte: edit both
copies together; the validator rejects drift. `.claude/agents/qa.md` and
`security.md` restate the Codex reviewers with only Read, Grep and Glob tools and
inherit the session model. Claude's built-in `/security-review` shares the project
skill's name; confirm which one runs before relying on it. Restart the session
after pulling instruction changes.

## Validation and GitHub gates

Run `python3 scripts/validate-ai-config.py` with Python 3.11+ (`python` on Windows
if appropriate). It checks TOML, the existing skills, references and instruction
budgets offline; it cannot prove runtime/model availability or effective settings.
AI/docs-only edits need no application build or tests. Changes to the validator
itself are executable changes and remain subject to full GitHub Quality.

GitHub owns CI. The required `quality` check still aggregates scope, application
and disposable database checks. Only allowlisted documentation/AI-only PRs skip
application/database jobs; executable/unknown paths, branch pushes and manual
runs require full checks. Delivery stops after push and PR creation/update;
CI failures are handled when the user supplies results. Do not infer green CI or
merge readiness from local validation. Release gates and database-first ordering
remain documented in [DEPLOYMENT.md](DEPLOYMENT.md).

## Troubleshooting and references

For ignored defaults, check client version, project trust and IDE/managed overrides.
Use `codex --version` and `codex --help` to find supported diagnostics; installed
CLI and JetBrains capabilities can differ. Do not start another model session or
interactive login merely to probe configuration.

Checked with Codex CLI 0.160.1 and official documentation on 2026-10-20:

- [Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Custom agents and inherited permissions](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [Project instructions](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [Skill discovery](https://learn.chatgpt.com/docs/build-skills)
