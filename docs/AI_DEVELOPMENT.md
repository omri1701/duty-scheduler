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
| `security` | Review material auth, RPC, permissions, private-data or migration changes | `gpt-6.1-sol` / `high` |

Root `AGENTS.md` supplies the routing policy; `.codex/config.toml` sets defaults
and caps active child agents at one. `.codex/agents/*.toml` defines the two
read-only reviewers. No custom developer or architect is needed yet.

Small tasks stay in the primary session. Complex behavioral changes get a QA
review once a diff exists; material security changes get a Security review.
Both run sequentially only for distinct risks. Hand off exact paths/diff,
acceptance criteria and existing results. Reviewers never spawn children or edit;
the primary agent fixes findings and runs missing checks. Read-only sandbox
settings are defaults, subject to live parent overrides; keep permissions tight.

| Skill under `.agents/skills/` | Trigger |
| --- | --- |
| `scheduling-regression` | Generation, points, weekends, constraints or month ownership |
| `code-change-validation` | Code/config edits or review; select relevant checks |
| `security-review` | Auth/RLS/RPC, permissions, private data, migrations or CI trust boundaries |

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

## Quality gates

`.github/workflows/quality.yml` runs on PRs to `develop`, pushes to `develop` and
manual dispatch. It pins action commits, Node and the package-manager version,
installs the frozen lockfile, validates AI metadata, runs the regression tests,
type checking, a lint regression gate and the production build. It uses a read-only GitHub token,
no application secrets, no AI and no deployment. GitHub Actions usage is subject
to your GitHub plan; no paid service was added.

`pnpm lint` currently reports seven pre-existing errors (React hooks and a link rule) and six warnings
on the initial base `304d894`. `node scripts/lint-regressions.mjs` prints those known
errors and fails on new errors. `scripts/lint-baseline.json` records exact file
hashes and diagnostic locations; changing a baseline file invalidates its allowance.
Rules remain enabled, and raw `pnpm lint` remains unchanged. Remove baseline entries
as the affected components are fixed; never regenerate/add allowances to pass CI.
This avoids unrelated application edits while establishing a usable new gate.

The engine's default seed is deterministic; existing multi-seed tests cover
variation. Production generation behavior is unchanged. Database RLS/OAuth and
real-device gestures are not covered by this CI. Follow the existing Supabase
setup document for isolated database checks; never use the live project.

Run `python3 scripts/validate-ai-config.py` (Python 3.11+) for offline TOML,
skill metadata and project contract checks. It is not the Codex runtime parser
and does not prove account access or successful delegation. Application commands
remain in README.md/package.json. After the first successful workflow run, an
owner should require its `quality` check and PR review in branch protection;
adding a workflow alone does not prevent merging failures.

## Small routing and usage check

In a fresh chat on a disposable local branch, ask:

> Add one deterministic regression in tests/engine.test.mjs showing that February
> 29, 2028 is covered exactly once with the regular weekday points. Reuse existing
> helpers, leave application code unchanged, and run the affected test file.
> Do not commit or push. Report selected skills, agents and checks.

Expected: scheduling-regression plus code-change-validation, one primary agent,
no reviewer for this small test-only change. To separately exercise delegation,
follow up: "Use qa to review this test-only diff; do not modify files."
This should create one QA reviewer, not Security or a chain of agents.

Record client/runtime version, actual model/effort, files read, tool calls,
elapsed time and client-reported input/cached/output/reasoning tokens when
available, including child usage. If IntelliJ lacks counters, record that gap;
do not infer token totals from message length. Compare the same task on the same
base with identical settings. Fewer retries and completed-task usage matter more
than a smaller parent transcript.

## Official references

Verified 2026-10-09; update deliberately when the installed runtime changes:

- [Project instructions](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Custom agents and delegation](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [Skill format and discovery](https://learn.chatgpt.com/docs/build-skills)
- [Models and reasoning](https://learn.chatgpt.com/docs/models)
- [IDE integrations](https://learn.chatgpt.com/docs/codex/ide)
