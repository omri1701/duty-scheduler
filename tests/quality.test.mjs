import test from 'node:test';
import assert from 'node:assert/strict';
import {appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {instructionOnly, selectChecks, SMOKE_SPECS, SPEC_MAP} from '../scripts/quality-scope.mjs';
import {FULL_QUALITY_JOBS, verifyQualityEvidence} from '../scripts/quality-evidence.mjs';
import {databaseSourceHash, verifyContractIdentity} from '../scripts/database-contract.mjs';
import {verifyProductionActivation} from '../scripts/release.mjs';

test('Quality executes the real lifecycle concurrency and conversion regressions',()=>{
 const workflow=readFileSync('.github/workflows/quality.yml','utf8');
 for(const file of ['lifecycle-races.mjs','lifecycle-upgrade.mjs'])assert(workflow.includes(`node supabase/tests/${file} supabase_db_duty-scheduler`));
});

test('database job installs locked application dependencies before the real HiGHS integration test',()=>{
 const workflow=readFileSync('.github/workflows/quality.yml','utf8');
 const database=workflow.split('\n  database:')[1].split('\n  quality:')[0];
 const setup=database.indexOf('uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1');
 const install=database.indexOf('run: pnpm install --frozen-lockfile');
 const regressions=database.indexOf('name: Fresh local database and permission regressions');
 const integration=database.indexOf('node supabase/tests/temporary-members.mjs supabase_db_duty-scheduler');
 assert(setup>=0&&setup<install&&install<regressions&&regressions<integration);
 assert(!database.includes('continue-on-error'));
});

function fixture(branch = 'master') {
  const sha = 'a'.repeat(40), repository = 'owner/duty', now = Date.parse('2026-10-13T12:00:00Z');
  const options = {repository, branch, sha, runId: '10', currentRunId: '20', now};
  const run = {id: 10, workflow_id: 9, path: '.github/workflows/quality.yml',
    repository: {id: 1, full_name: repository}, head_repository: {id: 1, full_name: repository},
    head_sha: sha, head_branch: branch, event: 'push', status: 'completed', conclusion: 'success',
    run_attempt: 2, run_started_at: '2026-10-13T11:00:00Z'};
  const jobs = FULL_QUALITY_JOBS.map(name => ({name, status: 'completed', conclusion: 'success'}));
  const artifact = {id: 100, name: `database-contract-${sha}-2`, expired: false,
    created_at: '2026-10-13T11:05:00Z', expires_at: '2026-10-20T11:05:00Z',
    workflow_run: {id: 10, repository_id: 1, head_repository_id: 1, head_sha: sha, head_branch: branch}};
  const artifacts = [artifact];
  const api = async suffix => {
    if (suffix === `/git/ref/heads/${branch}`) return {object: {sha: options.sha}};
    if (suffix === '/actions/workflows/quality.yml') return {id: 9};
    if (suffix === '/actions/runs/10') return run;
    if (suffix === '/actions/runs/10/attempts/2/jobs?per_page=100') return {jobs};
    if (suffix === '/actions/runs/10/artifacts?per_page=100') return {artifacts};
    throw Error(`Unexpected API endpoint ${suffix}`);
  };
  return {options, api, run, jobs, artifacts, artifact};
}

test('instruction-only PR allowlist fails closed and branch runs always execute full Quality', () => {
  const allowed = ['README.md', 'AGENTS.md', 'CLAUDE.md', 'docs/DEPLOYMENT.md', '.codex/config.toml', '.codex/agents/security.toml',
    '.agents/skills/feature-delivery/SKILL.md', '.claude/skills/feature-delivery/SKILL.md', '.claude/agents/qa.md'];
  assert(instructionOnly('pull_request', allowed));
  for (const event of ['push', 'workflow_dispatch', 'pull_request_target']) assert(!instructionOnly(event, allowed));
  assert(!instructionOnly('pull_request', []));
  for (const file of ['package.json', '.github/workflows/quality.yml', 'scripts/quality-scope.mjs', 'docs/runtime.mjs', '.agents/skills/new/SKILL.md', '.claude/skills/new/SKILL.md', '.claude/agents/new.md', '.claude/settings.json', '.claude/settings.local.json', '.claude/commands/x.md', '.claude/skills/feature-delivery/extra.md', '.Claude/agents/qa.md', '.mcp.json', 'app/page.tsx', 'supabase/tests/access.sql', 'tests/engine.test.mjs']) {
    assert(!instructionOnly('pull_request', [...allowed, file]), file);
  }
});

test('AI config validator rejects instruction-only changes that run commands, import files or widen reviewers', () => {
  const files = ['.codex', '.agents/skills', '.claude/skills', '.claude/agents', 'AGENTS.md', 'CLAUDE.md', 'README.md',
    'docs/AI_DEVELOPMENT.md', 'docs/SUPABASE_SETUP.md', 'tests/engine.test.mjs', 'tests/gesture.test.mjs',
    'tests/snapshot.test.mjs', 'supabase/tests/access.sql', '.github/workflows/quality.yml'];
  const skill = name => [`.agents/skills/${name}/SKILL.md`, `.claude/skills/${name}/SKILL.md`];
  const append = (paths, text) => root => paths.forEach(file => appendFileSync(join(root, file), text));
  const run = corrupt => {
    const root = mkdtempSync(join(tmpdir(), 'duty-ai-config-'));
    try {
      for (const file of files) cpSync(file, join(root, file), {recursive: true});
      corrupt?.(root);
      return spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['scripts/validate-ai-config.py', root], {encoding: 'utf8'});
    } finally { rmSync(root, {recursive: true, force: true}); }
  };
  const valid = run();
  assert.equal(valid.status, 0, valid.stderr);
  const corruptions = {
    'skills must not run shell commands': append(skill('feature-delivery'), '\n!`cat .env.local`\n'),
    'CLAUDE.md may import only @AGENTS.md': append(['CLAUDE.md'], '\nSee @.env.local\n'),
    'AGENTS.md must not import files': append(['AGENTS.md'], '\n@docs/DEPLOYMENT.md\n'),
    'must be identical': append(['.claude/skills/security-review/SKILL.md'], '\n'),
    'reviewer tools must be read-only': root => writeFileSync(join(root, '.claude/agents/qa.md'),
      readFileSync('.claude/agents/qa.md', 'utf8').replace('tools: Read, Grep, Glob', 'tools: Read, Grep, Glob, Bash')),
  };
  for (const [message, corrupt] of Object.entries(corruptions)) {
    const result = run(corrupt);
    assert.equal(result.status, 1, message);
    assert.match(result.stderr, new RegExp(message.replace(/[.@]/g, '\\$&')), message);
  }
});

test('Production evidence reuses the successful exact-SHA trusted full Quality attempt', async () => {
  const f = fixture();
  assert.deepEqual(await verifyQualityEvidence(f.api, f.options), {runId: '10', artifactId: '100'});
  f.run.event = 'workflow_dispatch';
  await verifyQualityEvidence(f.api, f.options);
});

test('reject unsuccessful, pending, PR, fork, wrong-workflow, branch and SHA runs', async () => {
  const corruptions = [
    run => run.conclusion = 'failure', run => run.conclusion = 'cancelled', run => run.status = 'in_progress',
    run => run.event = 'pull_request', run => run.event = 'pull_request_target', run => run.workflow_id = 999,
    run => run.path = '.github/workflows/forged.yml', run => run.head_sha = 'b'.repeat(40),
    run => run.head_branch = 'develop', run => run.repository.full_name = 'other/duty',
    run => run.head_repository.full_name = 'attacker/duty', run => run.run_attempt = 0,
  ];
  for (const corrupt of corruptions) {
    const f = fixture(); corrupt(f.run);
    await assert.rejects(verifyQualityEvidence(f.api, f.options));
  }
  const f = fixture(); f.options.sha = 'b'.repeat(40);
  await assert.rejects(verifyQualityEvidence(f.api, {...f.options, sha: 'a'.repeat(40)}), /branch head changed/);
});

test('reject missing, expired, stale, forged, wrong-attempt and ambiguous contract artifacts', async () => {
  const corruptions = [
    f => f.artifacts.length = 0, f => f.artifacts.push({...f.artifact}),
    f => f.artifact.expired = true, f => f.artifact.expires_at = '2026-10-13T11:59:59Z',
    f => f.artifact.created_at = '2026-10-13T10:59:59Z',
    f => {f.artifact.created_at = '2026-10-06T11:59:59Z'; f.run.run_started_at = '2026-10-06T10:00:00Z';},
    f => f.artifact.created_at = '2026-10-14T12:00:00Z',
    f => f.artifact.name = `database-contract-${f.options.sha}-1`,
    f => f.artifact.workflow_run.id = 11, f => f.artifact.workflow_run.repository_id = 2,
    f => f.artifact.workflow_run.head_repository_id = 2, f => f.artifact.workflow_run.head_sha = 'b'.repeat(40),
    f => f.artifact.workflow_run.head_branch = 'develop', f => delete f.artifact.workflow_run,
  ];
  for (const corrupt of corruptions) {
    const f = fixture(); corrupt(f);
    await assert.rejects(verifyQualityEvidence(f.api, f.options));
  }
});

test('full jobs cannot be missing, failed, skipped, cancelled or from a different attempt', async () => {
  assert.deepEqual(FULL_QUALITY_JOBS.filter(name => name.startsWith('browser ')), ['browser 1/4', 'browser 2/4', 'browser 3/4', 'browser 4/4']);
  for (const name of FULL_QUALITY_JOBS) {
    for (const conclusion of ['failure', 'skipped', 'cancelled', null]) {
      const f = fixture(); f.jobs.find(job => job.name === name).conclusion = conclusion;
      await assert.rejects(verifyQualityEvidence(f.api, f.options));
    }
    const f = fixture(); f.jobs.splice(f.jobs.findIndex(job => job.name === name), 1);
    await assert.rejects(verifyQualityEvidence(f.api, f.options));
  }
});

test('Development can consume only its own in-progress run with successful full Quality jobs', async () => {
  const f = fixture('develop'); f.run.status = 'in_progress'; f.run.conclusion = null; f.options.currentRunId = '10';
  await verifyQualityEvidence(f.api, f.options);
  await assert.rejects(verifyQualityEvidence(f.api, {...f.options, currentRunId: '20'}));
  f.jobs[1].conclusion = 'failure';
  await assert.rejects(verifyQualityEvidence(f.api, f.options));
});

test('Production activation defaults disabled and requires manual dispatch', () => {
  verifyProductionActivation({RELEASE_BRANCH: 'develop', GITHUB_EVENT_NAME: 'push'});
  for (const value of [undefined, 'false', 'TRUE', '']) assert.throws(() => verifyProductionActivation({RELEASE_BRANCH: 'master', GITHUB_EVENT_NAME: 'workflow_dispatch', PRODUCTION_DEPLOYMENT_ENABLED: value}), /disabled/);
  assert.throws(() => verifyProductionActivation({RELEASE_BRANCH: 'master', GITHUB_EVENT_NAME: 'push', PRODUCTION_DEPLOYMENT_ENABLED: 'true'}), /manual dispatch/);
  verifyProductionActivation({RELEASE_BRANCH: 'master', GITHUB_EVENT_NAME: 'workflow_dispatch', PRODUCTION_DEPLOYMENT_ENABLED: 'true'});
});

test('downloaded contract identity rejects mismatched commit, SQL sources and migrations', async () => {
  const migrations = (await readdir('supabase/migrations')).sort().map(name => [name.slice(0, 14), name.slice(15, -4)]);
  const contract = {sha: 'a'.repeat(40), sourceHash: await databaseSourceHash(), migrations, fingerprint: Array(7).fill('catalog').join('\n'), referenceData: {}};
  await verifyContractIdentity(contract, contract.sha);
  await assert.rejects(verifyContractIdentity({...contract, sha: 'b'.repeat(40)}, contract.sha));
  await assert.rejects(verifyContractIdentity({...contract, sourceHash: 'forged'}, contract.sha));
  await assert.rejects(verifyContractIdentity({...contract, migrations: []}, contract.sha));
});

test('required quality gate cannot silently skip checks; browsers and releases have separate runners/locks', () => {
  const workflow = readFileSync('.github/workflows/quality.yml', 'utf8');
  const gate = workflow.split('\n  quality:')[1].split('\n  deploy-development:')[0];
  assert.match(gate, /needs: \[scope, application, browser, browser-report, database\]/);
  assert.match(gate, /if: always\(\)/);
  assert.equal(workflow.match(/pnpm test:e2e:ci/g)?.length, 2, 'one selected PR run and one sharded full run');
  assert.equal(workflow.match(/run: pnpm build/g)?.length, 2, 'application and each browser shard build once');
  assert.equal(workflow.match(/supabase db start/g)?.length, 1);
  assert.match(workflow, /if: needs\.scope\.outputs\.application == 'true'/);
  assert.match(workflow, /if: needs\.scope\.outputs\.database == 'true'/);
  assert.match(workflow, /if: needs\.scope\.outputs\.browser == 'full'/);
  assert.match(workflow, /name: browser \$\{\{ matrix\.shard \}\}\/4/);
  assert.match(workflow, /shard: \[1, 2, 3, 4\]/);
  assert.match(workflow, /group: quality-browser-\$\{\{ github\.ref \}\}-\$\{\{ matrix\.shard \}\}/, 'shards must not cancel each other');
  assert(!workflow.split('jobs:')[0].includes('cancel-in-progress'), 'Testing concurrency must not cancel deploy jobs');
  const deploy = readFileSync('.github/workflows/deploy.yml', 'utf8');
  assert.match(deploy, /cancel-in-progress: false/);
  assert.match(deploy, /artifact-ids: \$\{\{ needs.authorize.outputs.artifact-id \}\}/);
  assert.match(deploy, /run-id: \$\{\{ inputs.quality-run-id \}\}/);
  assert(deploy.indexOf('scripts/quality-evidence.mjs') < deploy.indexOf('--approval-only'));
});

const spec = name => `tests/browser/${name}.spec.ts`;
const smoke = SMOKE_SPECS.map(spec);

test('selector: branch runs, unknown and global paths select every check', () => {
  const full = {application: true, database: true, browser: 'full', specs: []};
  for (const event of ['push', 'workflow_dispatch', 'pull_request_target', undefined]) assert.deepEqual(selectChecks(event, ['components/rota/swap-requests.tsx']), full);
  assert.deepEqual(selectChecks('pull_request', []), full);
  for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', 'next.config.ts', 'tsconfig.json', 'postcss.config.mjs',
    'eslint.config.mjs', 'playwright.config.ts', 'components.json', 'vercel.json', 'app/globals.css', 'app/tailwind.css', 'app/layout.tsx', 'app/page.tsx',
    'components/rota/workspace.tsx', 'components/ui/button.tsx', 'lib/utils.ts', 'hooks/use-team-workspace.ts', 'vendor/shadcn-tailwind-4.13.0.css',
    'tests/browser/fixtures.ts', 'tests/browser/zoom-context.mjs', 'tests/browser/snapshots/linux/desktop/x.png', 'tests/fixtures/generation.mjs',
    '.github/workflows/quality.yml', '.github/workflows/deploy.yml', 'scripts/quality-scope.mjs', 'scripts/browser-container.mjs',
    'scripts/visual-review-reporter.mjs', 'drizzle/meta/_journal.json', 'public/favicon.svg', 'components/new-feature.tsx', 'lib/new/x.ts']) {
    assert.deepEqual(selectChecks('pull_request', ['components/rota/swap-requests.tsx', file]), full, file);
  }
});

test('selector: the scope script and workflows can never narrow their own checks', () => {
  for (const file of ['scripts/quality-scope.mjs', '.github/workflows/quality.yml', 'scripts/quality-evidence.mjs'])
    assert.equal(selectChecks('pull_request', [file, 'README.md']).browser, 'full', file);
  const workflow = readFileSync('.github/workflows/quality.yml', 'utf8');
  const scope = workflow.split('\n  scope:')[1].split('\n  application:')[0];
  assert.match(scope, /git show "\$PR_BASE:scripts\/quality-scope\.mjs" > "\$RUNNER_TEMP\/quality-scope\.mjs"/);
  assert.match(scope, /node "\$RUNNER_TEMP\/quality-scope\.mjs"/);
  assert(!/node scripts\/quality-scope\.mjs/.test(workflow), 'PR-controlled selector must not run');
});

test('selector: UI changes run unit/tsc/lint/build plus mapped specs and smoke, without the database', () => {
  const checks = selectChecks('pull_request', ['components/rota/swap-requests.tsx', 'tests/swaps.test.mjs', 'docs/DEPLOYMENT.md']);
  assert.deepEqual(checks, {application: true, database: false, browser: 'selected', specs: [...new Set([spec('calendar-controls'), spec('swaps'), ...smoke])].sort()});
  const own = selectChecks('pull_request', ['tests/browser/duty-locks.spec.ts'], () => true);
  assert.deepEqual(own.specs, [...new Set([spec('duty-locks'), ...smoke])].sort());
  assert.equal(selectChecks('pull_request', ['tests/browser/gone.spec.ts'], () => false).browser, 'full', 'deleted specs cannot be selected');
  assert.deepEqual(selectChecks('pull_request', ['tests/engine.test.mjs']), {application: true, database: false, browser: 'none', specs: []});
});

test('selector: SQL and Supabase client changes add the database job', () => {
  assert.deepEqual(selectChecks('pull_request', ['supabase/schemas/x.sql', 'supabase/tests/access.sql']), {application: true, database: true, browser: 'none', specs: []});
  const client = selectChecks('pull_request', ['lib/supabase/swaps.ts']);
  assert.equal(client.database, true);
  assert.equal(client.browser, 'selected');
  assert(client.specs.includes(spec('supabase-lifecycle')) && smoke.every(s => client.specs.includes(s)));
  assert.equal(selectChecks('pull_request', ['lib/other/query.sql']).browser, 'full');
});

test('selector: docs/AI-only PRs still skip application and database checks', () => {
  assert.deepEqual(selectChecks('pull_request', ['README.md', 'docs/AI_DEVELOPMENT.md']), {application: false, database: false, browser: 'none', specs: []});
});

test('selector map names only existing sources and specs', () => {
  for (const [source, names] of Object.entries(SPEC_MAP)) {
    assert(existsSync(source), source);
    assert(names.length > 0, source);
    for (const name of names) assert(existsSync(spec(name)), `${source} -> ${name}`);
  }
  for (const name of SMOKE_SPECS) assert(existsSync(spec(name)), name);
});

function workflowRun(workflow, step) {
  const lines = workflow.split('\n'), start = lines.findIndex(line => line.trim() === `- name: ${step}`);
  const run = lines.findIndex((line, index) => index > start && line.trim() === 'run: |');
  const indent = lines[run + 1].search(/\S/), body = [];
  for (const line of lines.slice(run + 1)) { if (line.trim() && line.search(/\S/) < indent) break; body.push(line.slice(indent)); }
  return body.join('\n');
}
const bash = (script, env) => spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {encoding: 'utf8', env: {PATH: process.env.PATH, ...env}});

test('selection normalization fails closed and validates spec names', () => {
  const script = workflowRun(readFileSync('.github/workflows/quality.yml', 'utf8'), 'Normalize selection (fail closed)');
  const normalize = env => {
    const dir = mkdtempSync(join(tmpdir(), 'duty-scope-')), output = join(dir, 'out');
    try {
      writeFileSync(output, '');
      const result = bash(script, {GITHUB_OUTPUT: output, ...env});
      return result.status === 0 ? Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map(line => line.split(/=(.*)/s).slice(0, 2))) : null;
    } finally { rmSync(dir, {recursive: true, force: true}); }
  };
  const full = {application: 'true', database: 'true', browser: 'full', specs: ''};
  assert.deepEqual(normalize({EVENT: 'push', APPLICATION: 'false', DATABASE: 'false', BROWSER: 'none'}), full);
  assert.deepEqual(normalize({EVENT: 'pull_request'}), full, 'a base selector without tiered outputs runs everything');
  assert.deepEqual(normalize({EVENT: 'pull_request', APPLICATION: 'true', DATABASE: 'false', BROWSER: 'selected', SPECS: ''}), {...full, database: 'false'});
  assert.deepEqual(normalize({EVENT: 'pull_request', APPLICATION: 'true', DATABASE: 'false', BROWSER: 'selected', SPECS: 'tests/browser/a.spec.ts tests/browser/b-c.spec.ts'}),
    {application: 'true', database: 'false', browser: 'selected', specs: 'tests/browser/a.spec.ts tests/browser/b-c.spec.ts'});
  for (const bad of ['tests/browser/*.spec.ts', '--grep=x', 'tests/browser/../x.spec.ts', 'tests/browser/a.spec.ts;id'])
    assert.equal(normalize({EVENT: 'pull_request', APPLICATION: 'true', DATABASE: 'true', BROWSER: 'selected', SPECS: bad}), null, bad);
  assert.equal(normalize({EVENT: 'pull_request', APPLICATION: 'false', DATABASE: 'true', BROWSER: 'none'}), null);
  assert.deepEqual(normalize({EVENT: 'pull_request', APPLICATION: 'false', DATABASE: 'false', BROWSER: 'none'}), {application: 'false', database: 'false', browser: 'none', specs: ''});
});

test('aggregate gate fails when any selected job failed or an unselected job did not skip', () => {
  const script = workflowRun(readFileSync('.github/workflows/quality.yml', 'utf8'), 'Require selected checks');
  const ok = env => bash(script, {SCOPE: 'success', ...env}).status === 0;
  const push = {EVENT: 'push', RUN_APPLICATION: 'true', RUN_DATABASE: 'true', RUN_BROWSER: 'full', APPLICATION: 'success', DATABASE: 'success', BROWSER: 'success', BROWSER_REPORT: 'success'};
  assert(ok(push));
  for (const job of ['APPLICATION', 'DATABASE', 'BROWSER', 'BROWSER_REPORT'])
    for (const result of ['failure', 'cancelled', 'skipped', '']) assert(!ok({...push, [job]: result}), `${job}=${result}`);
  assert(!ok({...push, SCOPE: 'failure'}));
  assert(!ok({...push, RUN_BROWSER: 'selected', BROWSER: 'skipped', BROWSER_REPORT: 'skipped'}), 'branch runs must be full');
  assert(!ok({...push, RUN_DATABASE: 'false', DATABASE: 'skipped'}), 'branch runs must include the database');
  const ui = {EVENT: 'pull_request', RUN_APPLICATION: 'true', RUN_DATABASE: 'false', RUN_BROWSER: 'selected', APPLICATION: 'success', DATABASE: 'skipped', BROWSER: 'skipped', BROWSER_REPORT: 'skipped'};
  assert(ok(ui));
  assert(ok({...ui, RUN_DATABASE: 'true', DATABASE: 'success'}));
  assert(!ok({...ui, RUN_DATABASE: 'true', DATABASE: 'failure'}));
  assert(!ok({...ui, DATABASE: 'failure'}), 'an unselected job that ran and failed still fails the gate');
  assert(!ok({...ui, APPLICATION: 'failure'}));
  assert(!ok({...ui, RUN_BROWSER: 'bogus'}));
  assert(ok({EVENT: 'pull_request', RUN_APPLICATION: 'false', RUN_DATABASE: 'false', RUN_BROWSER: 'none', APPLICATION: 'skipped', DATABASE: 'skipped', BROWSER: 'skipped', BROWSER_REPORT: 'skipped'}));
  assert(!ok({...push, EVENT: 'pull_request', BROWSER: 'skipped'}));
});
