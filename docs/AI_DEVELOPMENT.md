# AI development

## Start in IntelliJ

Use Codex in JetBrains AI Chat, sign in with ChatGPT, open this repository and
trust the project after reviewing its configuration. Start a new Codex session
after pulling instruction/config changes. Project configuration is loaded only
for trusted projects; IDE selections, launch overrides and managed settings can
override defaults. Verify the effective model and available agents/skills in your
installed client before relying on routing.

The setup uses no external model provider, API key, AI SDK or AI CI calls.
`forced_login_method = "chatgpt"` requests subscription authentication in supported
local Codex clients; account limits still apply. Do not add API credentials as a
fallback. ChatGPT's GitHub connection does not automatically configure IntelliJ's
Git credentials or connectors.

## Architecture and routing

| Component | Responsibility | Model / effort |
| --- | --- | --- |
| Primary Codex session | Scope, implementation, checks and final decision | `gpt-6.1-sol` / `low` |
| `qa` | Focused review of complex scheduling or cross-layer behavior | `gpt-6-luna` / `high` |
| `security` | Review material auth, RPC, permissions, private-data, migration or CI trust boundaries | `gpt-6.1-sol` / `high` |

Root `AGENTS.md` supplies the routing policy; `.codex/config.toml` sets defaults
and caps active child agents at one. `.codex/agents/*.toml` defines the two
read-only reviewers. No custom developer or architect is needed yet.

Follow root routing for review scope and handoff; ordinary tasks stay in the
primary session. Reviewer read-only settings are defaults subject to live parent
overrides, not proof of enforced read-only execution.

| Skill under `.agents/skills/` | Trigger |
| --- | --- |
| `scheduling-regression` | Generation, points, weekends, constraints or month ownership |
| `code-change-validation` | Code/config edits, diff reviews or authorized PR delivery; select relevant checks |
| `security-review` | Auth/RLS/RPC, permissions, private data, migrations or CI trust boundaries |
| `feature-delivery` | Explicitly authorized end-to-end Git delivery through a PR; no implicit commit/push permission |

Skill metadata is discovered initially; full instructions load when selected.
Skills do not spawn agents themselves, and checks already completed for the same
diff are reused. A skill can be invoked explicitly with `$skill-name` in a
supporting client. Root instructions route known tasks even if implicit matching
does not choose a skill automatically.

## What is automatic, and what is not

- Codex can choose skills and delegate based on the root policy when the installed
  runtime supports project agents. Routing is model judgment, not a guaranteed
  deterministic dispatcher. Missing capabilities fall back to one disclosed local
  review, not hidden retries or an external provider.
- The primary session does not automatically change its own model/effort because
  a Markdown instruction requests it. For complex implementation, select Medium
  or High before starting. The review agents have their own configured settings.
- The exact model IDs are documented by OpenAI, but account/client entitlement
  cannot be established from repository configuration. If a model is absent,
  select an available OpenAI model in your client and update the affected defaults
  and validation contract intentionally; do not silently substitute a provider.
- JetBrains uses its own integration. Agent discovery, selectors, activity and
  usage reporting depend on its bundled Codex version. If unsupported, update it
  or use a current ChatGPT-authenticated Codex CLI in IntelliJ's terminal.
- Permissions, login, project trust, browser/device checks and final merge remain
  human-controlled. Commits/pushes/PR creation require task authorization; PR
  authorization never includes merging or live database changes.

## Quality gates and efficient execution

Quality runs for PRs to `develop`/`master`, pushes to both branches and manual
requests. The required `quality` check aggregates scope, application and database
results. Application/unit/scheduling/type/lint/build/browser checks and disposable
SQL/security/upgrade/release-order checks run in parallel on separate runners.
Test jobs use read-only tokens, no hosted credentials and no AI calls. Successful
Development branch Quality may then call the Environment-scoped release workflow;
Production has a separate manual workflow with trusted exact-SHA Quality evidence.
See [deployment gates and recovery](DEPLOYMENT.md).

The existing lockfile-keyed pnpm store cache remains. Database jobs install no JS
dependencies; browser tests reuse one build/install and the pinned browser image.
Large Docker image archives are not added to the cache: restore/save overhead and
storage compete with cold pulls. Revisit only with comparable measured evidence.

Only PRs whose entire diff is known documentation or validated AI instructions
skip application/database jobs. AI metadata, canonical SQL packaging and immutable
migration policy still run. Executable scripts, workflows, dependencies, SQL,
tests and unknown paths require full checks. Branch pushes and manual Quality
always run everything. The `quality` branch-protection name stays unchanged.

Use code-change-validation to choose focused local checks while developing.
Reuse successful results for unchanged inputs; run relevant comprehensive checks
once before delivery. Diagnose a failed command before retrying. Expensive local
Docker/build/browser checks are needed when affected behavior or CI harness changes
justify them; docs/AI-only edits need metadata validation, not an app build.
Never regenerate lint allowances or visual snapshots merely to pass a regression.
CI verifies real disposable database RLS; Google OAuth and real-device gestures
still require authorized manual acceptance.

`python3 scripts/validate-ai-config.py` (Python 3.11+) validates the two reviewers,
four skills and instruction budgets offline. It does not prove live agent/model
availability, effective settings or account entitlement. Keep the existing primary,
QA and Security choices; no additional provider, agent or paid API is required.

## Runtime troubleshooting

When project defaults appear ignored, check the client's version, project trust,
effective configuration and any IDE/managed overrides. Use `codex --version` and
`codex --help` before choosing diagnostic commands; app-server schemas vary by
installed runtime. A previous standalone CLI probe found the project layer disabled
because it was untrusted. That does not establish IntelliJ's current session state.
Skill discovery proves availability, not invocation or effectiveness. Reviewer
read-only configuration and routing remain subject to the active runtime.

If configured agents/models are unavailable, disclose the limitation and perform
the focused review locally; never silently change providers or request API billing.
Project instructions cannot switch the primary model mid-task. GitHub connector
access does not establish shell Git authentication. Run available login commands
when necessary without exposing credentials; resume after authentication.

## Lightweight efficiency sampling

Sample a meaningful task occasionally, especially after routing changes or a costly
failure. Use the existing transcript/check output and one short PR or local note;
no service, database, CI AI calls or per-task instrumentation is needed:

- Task/base and client/effective model; start/end time and elapsed duration.
- Distinct files examined, tool calls/repeated attempts **only when observable**.
- Selected skills and agents, with each review's reason.
- Checks executed/reused, success, regressions and remaining limitations.
- Client-reported token usage, including child usage, **only if exposed**; otherwise
  write `unavailable`. Never estimate tokens from text length or call count.

Compare similar tasks on the same base/settings. Look for repeated reads, full-suite
reruns on unchanged inputs, undiagnosed retries and unnecessary reviewers. Improve
those first; a shorter report alone does not prove lower token consumption. Routine
tasks need only the concise delivery report, not a separate measurement exercise.

## Official references

Checked 2026-10-10 against official guidance; update when the runtime changes:

- [Project instructions](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Custom agents and delegation](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [Skill format and discovery](https://learn.chatgpt.com/docs/build-skills)
- [Models and reasoning](https://learn.chatgpt.com/docs/models)
- [IDE integrations](https://learn.chatgpt.com/docs/codex/ide)
