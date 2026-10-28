import test from 'node:test';
import assert from 'node:assert/strict';
import {appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {instructionOnly} from '../scripts/quality-scope.mjs';
import {verifyQualityEvidence} from '../scripts/quality-evidence.mjs';
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
  const jobs = ['scope', 'application', 'database', 'quality'].map(name => ({name, status: 'completed', conclusion: 'success'}));
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
  for (const name of ['scope', 'application', 'database', 'quality']) {
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
  assert.match(gate, /needs: \[scope, application, database\]/);
  assert.match(gate, /if: always\(\)/);
  for (const check of ['SCOPE', 'APPLICATION', 'DATABASE']) assert(gate.includes(`test "$${check}" = success`));
  assert.equal(workflow.match(/run: pnpm test:e2e:ci/g)?.length, 1);
  assert.equal(workflow.match(/run: pnpm build/g)?.length, 1);
  assert.equal(workflow.match(/supabase db start/g)?.length, 1);
  assert(!workflow.split('jobs:')[0].includes('cancel-in-progress'), 'Testing concurrency must not cancel deploy jobs');
  const deploy = readFileSync('.github/workflows/deploy.yml', 'utf8');
  assert.match(deploy, /cancel-in-progress: false/);
  assert.match(deploy, /artifact-ids: \$\{\{ needs.authorize.outputs.artifact-id \}\}/);
  assert.match(deploy, /run-id: \$\{\{ inputs.quality-run-id \}\}/);
  assert(deploy.indexOf('scripts/quality-evidence.mjs') < deploy.indexOf('--approval-only'));
});
