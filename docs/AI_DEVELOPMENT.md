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

## Quality gates

`.github/workflows/quality.yml` runs on PRs to `develop`, pushes to `develop` and
manual dispatch. It pins action commits, Node and the package-manager version,
installs the frozen lockfile, validates AI metadata, runs the regression tests,
type checking, a lint regression gate and the production build. It uses a read-only GitHub token,
no application secrets, no AI and no deployment. GitHub Actions usage is subject
to your GitHub plan; no paid service was added.

`pnpm lint` and `node scripts/lint-regressions.mjs` pass without error allowances.
`scripts/lint-baseline.json` is empty after resolving the React Hooks debt; never
regenerate or add allowances to pass CI. Hook rules also apply to the retained UI
components.

Existing deterministic multi-seed tests cover scheduling variation; production
generation uses fresh cryptographic seeds. Database RLS/OAuth and
real-device gestures are not covered by this CI. Follow the existing Supabase
setup document for isolated database checks; never use the live project.

Run `python3 scripts/validate-ai-config.py` (Python 3.11+) for offline TOML,
skill metadata and project contract checks. It is not the Codex runtime parser
and does not prove account access or successful delegation. Application commands
remain in README.md/package.json. After the first successful workflow run, an
owner should require its `quality` check and PR review in branch protection;
adding a workflow alone does not prevent merging failures.

Select local checks with code-change-validation; it distinguishes application PRs
from documentation/AI infrastructure. Every PR requires successful Quality CI on
its final head. CI triggers and application coverage are unchanged.

## Verified evidence and runtime limits

Audit date: 2026-10-10, base `develop` at `6aab26b`.

The audit aligned `.gitignore` with the four existing skills: `feature-delivery`
was tracked but its directory remained ignored, causing ordinary staging to fail.

- [#2](https://github.com/omri1701/duty-scheduler/pull/2) established the setup but
  explicitly lacked runtime, skill-selection, delegation and token evidence.
- [#4](https://github.com/omri1701/duty-scheduler/pull/4),
  [#5](https://github.com/omri1701/duty-scheduler/pull/5),
  [#6](https://github.com/omri1701/duty-scheduler/pull/6) and
  [#7](https://github.com/omri1701/duty-scheduler/pull/7) report focused reviews and
  preserved browser baselines; [#8](https://github.com/omri1701/duty-scheduler/pull/8)
  reports a Security-found stale join-error race reproduced, fixed and re-reviewed.
  GitHub Actions confirms successful Quality runs on all six final PR heads.
  Fetched discussions contain no reviewer transcripts or skill execution traces.
  PR descriptions support reported outcomes, not verified agent/model execution.
- Installed JetBrains-bundled Codex CLI `0.160.1`: its bundled catalog advertises
  both configured models and efforts. No inference or account-entitlement test ran.
  App-server `skills/list` discovered all four project skills enabled without errors;
  discovery does not establish invocation or effectiveness.
- App-server `config/read` with repository `cwd` and `includeLayers: true` showed
  the standalone CLI project layer disabled for missing project trust. Consequently
  its repository model/login/concurrency defaults were not effective in that probe.
  This does not establish IntelliJ's active session settings. Persistent trust and
  authentication were left unchanged; the CLI diagnostic reported ChatGPT auth.

When defaults appear ignored, check `codex --version`, then inspect the effective
config and each layer's `disabledReason` through
[app-server configuration inspection](https://learn.chatgpt.com/docs/app-server).
Trust the reviewed project in the client used for work and start a fresh session;
verify effective settings there. Schema/metadata validation alone cannot do this.
Historical session logs and token measurements were not available for this audit;
shorter instructions must not be reported as measured token savings. Keep the
single-primary workflow and current reviewers until measured task outcomes justify
more orchestration; use the small comparison below before changing model defaults.

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

Checked 2026-10-10 against official guidance; update when the runtime changes:

- [Project instructions](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Custom agents and delegation](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [Skill format and discovery](https://learn.chatgpt.com/docs/build-skills)
- [Models and reasoning](https://learn.chatgpt.com/docs/models)
- [IDE integrations](https://learn.chatgpt.com/docs/codex/ide)
