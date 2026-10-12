import assert from 'node:assert/strict';
import {readFile, appendFile, mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {historyQuery, referenceQuery, verifyHistory} from './database-contract.mjs';

export const environments = Object.freeze({
  develop: {name: 'Development', ref: 'qhndiuahuxczujxxitsm', target: 'preview', domain: 'duty-scheduler-dev.vercel.app'},
  master: {name: 'Production', ref: 'hpszwgnwxtxyxpcaivgj', target: 'production', domain: 'duty-scheduler-prod.vercel.app'},
});
const project = 'prj_Jl2PBhK8DsvK183rKKWesr0821OY';
const team = 'team_pbvqzViC50aeT2kaRNnTYkPt';

export function connectionEnvironment(value, ref) {
  // Never print URL parsing errors, which can include passwords.
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid SUPABASE_DB_URL'); }
  assert(['postgres:', 'postgresql:'].includes(url.protocol), 'Use a PostgreSQL connection string');
  const user = decodeURIComponent(url.username);
  const direct = url.hostname === `db.${ref}.supabase.co` && user === 'postgres';
  const pooler = /^aws-\d+-eu-central-1\.pooler\.supabase\.com$/.test(url.hostname) && user === `postgres.${ref}`;
  assert(direct || pooler, 'Database credential points outside the selected Frankfurt environment');
  assert((url.port || '5432') === '5432', 'Use direct or session-mode pooling, never transaction pooling');
  assert(url.pathname === '/postgres' && url.password, 'Database and password are required');
  assert.equal(url.searchParams.get('sslmode'), 'require', 'SUPABASE_DB_URL must include sslmode=require');
  assert.deepEqual([...url.searchParams.keys()], ['sslmode'], 'Unsupported database URL options');
  return {PGHOST: url.hostname, PGPORT: '5432', PGUSER: user, PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: 'postgres', PGSSLMODE: 'require', PGCONNECT_TIMEOUT: '15',
    PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=60000'};
}

export function databasePushInvocation(pg, dryRun) {
  const url = new URL('postgresql://localhost/postgres?sslmode=require');
  url.hostname = pg.PGHOST;
  url.port = pg.PGPORT;
  url.username = pg.PGUSER;
  return {
    args: ['db', 'push', '--db-url', url.href, '--skip-vault', '--yes', ...(dryRun ? ['--dry-run'] : [])],
    env: {PGPASSWORD: pg.PGPASSWORD, SUPABASE_DB_PASSWORD: pg.PGPASSWORD},
  };
}

// Shared by real releases and the isolated integration test: a failed migration,
// incomplete history or contract mismatch can never reach deployApplication.
export async function releaseDatabaseFirst({query, push, deployApplication, contract, fingerprintSQL}) {
  const pending = verifyHistory(await query(historyQuery), contract.migrations);
  console.log(`Database preflight: ${pending.length} pending migration(s)`);
  if (pending.length) {
    await push(true);
    await push(false);
  }
  verifyHistory(await query(historyQuery), contract.migrations, true);
  assert.equal((await query(fingerprintSQL)).trim(), contract.fingerprint, 'Database schema/RLS/RPC contract mismatch');
  assert.deepEqual(JSON.parse(await query(referenceQuery)), contract.referenceData, 'Static reference-data contract mismatch');
  console.log('PASS: complete migration history and database contracts');
  return deployApplication();
}

export async function verifyReleaseApproval(api, branch, sha) {
  assert(environments[branch], 'Only develop and master can deploy');
  assert.match(sha, /^[a-f0-9]{40}$/);
  const current = await api(`/git/ref/heads/${branch}`);
  assert.equal(current.object.sha, sha, 'Superseded release; rerun Quality for the latest branch commit');
  if (branch !== 'master') return;
  const environment = await api('/environments/Production');
  assert(environment.protection_rules.some(rule => rule.type === 'required_reviewers' && rule.reviewers.length),
    'Production requires GitHub Environment deployment approval before activation');
  assert.equal(environment.can_admins_bypass, false, 'Production approval must not allow admin bypass');
  assert((await api('/branches/master')).protected, 'Production branch must remain protected');
  const prs = await api(`/commits/${sha}/pulls?per_page=100`);
  const release = prs.find(pr => pr.merged_at && pr.merge_commit_sha === sha && pr.base.ref === 'master'
    && pr.head.ref === 'develop' && pr.head.repo?.full_name === process.env.GITHUB_REPOSITORY);
  assert(release, 'Production requires a merged develop -> master release PR');
  // A solo owner cannot approve their own PR. Branch protection requires the PR
  // and Quality; the Environment provides the separate, auditable release approval.
  const deployments = await api(`/deployments?sha=${release.head.sha}&environment=Development&per_page=100`);
  let developmentPassed = false;
  for (const deployment of deployments) {
    const statuses = await api(`/deployments/${deployment.id}/statuses?per_page=1`);
    if (statuses[0]?.state === 'success') { developmentPassed = true; break; }
  }
  assert(developmentPassed, 'Release head must have a successful Development deployment');
}

async function main() {
  const {RELEASE_BRANCH: branch, RELEASE_SHA: sha, GITHUB_REPOSITORY: repository} = process.env;
  const selected = environments[branch];
  assert(selected && process.env.GITHUB_REF === `refs/heads/${branch}`, 'Wrong release branch context');
  assert(['push', 'workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME), 'PRs cannot deploy');
  const api = async suffix => {
    const response = await fetch(`https://api.github.com/repos/${repository}${suffix}`, {
      headers: {Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json'},
    });
    if (response.status === 404 && /^\/collaborators\/[^/]+\/permission$/.test(suffix)) return {permission: 'none'};
    assert(response.ok, `GitHub release gate failed (${response.status})`);
    return response.json();
  };
  await verifyReleaseApproval(api, branch, sha);
  if (process.argv[2] === '--approval-only') return;
  const contract = JSON.parse(await readFile('work/database-contract.json', 'utf8'));
  assert.equal(contract.sha, sha, 'Quality contract must belong to this exact commit');
  const pg = connectionEnvironment(process.env.SUPABASE_DB_URL, selected.ref);
  assert.equal(process.env.VERCEL_PROJECT_ID, project, 'Unexpected Vercel project');
  assert.equal(process.env.VERCEL_ORG_ID, team, 'Unexpected Vercel team');
  assert(process.env.VERCEL_TOKEN && process.env.SUPABASE_PUBLISHABLE_KEY?.startsWith('sb_publishable_'), 'Missing environment secrets');
  const authSettings = await fetch(`https://${selected.ref}.supabase.co/auth/v1/settings`, {
    headers: {apikey: process.env.SUPABASE_PUBLISHABLE_KEY}, signal: AbortSignal.timeout(15000),
  });
  assert(authSettings.ok, 'Publishable key does not authenticate against the selected Supabase project');
  const childEnvironment = {...process.env};
  for (const name of ['GH_TOKEN', 'SUPABASE_DB_URL', 'SUPABASE_DB_PASSWORD', 'PGPASSWORD', 'SUPABASE_PUBLISHABLE_KEY', 'VERCEL_TOKEN']) delete childEnvironment[name];
  const run = (command, args, options = {}) => {
    const result = spawnSync(command, args, {encoding: 'utf8', env: childEnvironment, ...options});
    // SQL errors may contain private rows and CLI errors may echo credentials.
    // Stage names/exit status are safe; detailed diagnostics belong to the operator.
    assert.equal(result.status, 0, `${command} failed (${result.status}); inspect the service dashboard privately`);
    return result.stdout.trim();
  };
  const vercel = args => run('pnpm', ['dlx', 'vercel@62.0.0', ...args], {env: {...childEnvironment, VERCEL_TOKEN: process.env.VERCEL_TOKEN}});
  assert.equal(run('git', ['rev-parse', 'HEAD']), sha, 'Release checkout must match the verified branch SHA');
  run('git', ['diff', '--quiet', 'HEAD']);
  const vercelAPI = endpoint => JSON.parse(vercel(['api', `${endpoint}?teamId=${team}`, '--method', 'GET']));
  const settings = vercelAPI(`/v9/projects/${project}`);
  assert.equal(settings.ssoProtection?.deploymentType, 'all_except_custom_domains', 'Preserve Vercel Authentication');
  assert.equal(settings.autoAssignCustomDomains, true, 'Automatic domain assignment must stay enabled');
  const domains = vercelAPI(`/v9/projects/${project}/domains`).domains;
  assert(domains.some(domain => domain.name === selected.domain && domain.gitBranch === (branch === 'develop' ? branch : null)),
    'Existing domain is not bound to the selected environment');
  await releaseDatabaseFirst({contract, fingerprintSQL: await readFile('supabase/tests/fingerprint.sql', 'utf8'),
    query: sql => run('psql', ['-XqAt', '-v', 'ON_ERROR_STOP=1'], {input: sql, env: {...childEnvironment, ...pg}}),
    push: dryRun => {
      console.log(dryRun ? 'Database migration dry run' : 'Applying pending database migrations');
      const migration = databasePushInvocation(pg, dryRun);
      run('supabase', migration.args, {env: {...childEnvironment, ...migration.env}});
    },
    deployApplication: async () => {
      await verifyReleaseApproval(api, branch, sha);
      console.log(`Deploying verified ${branch} application to Vercel ${selected.target}`);
      // The publishable key is intentionally public at runtime, but it need not
      // appear in process listings. Keep deployment overrides outside the upload
      // tree in a temporary owner-readable CLI config, removed even on failure.
      const directory = await mkdtemp(path.join(tmpdir(), 'duty-vercel-'));
      let url;
      try {
        const config = JSON.parse(await readFile('vercel.json', 'utf8'));
        config.env = {...config.env, SUPABASE_URL: `https://${selected.ref}.supabase.co`,
          SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY};
        const filename = path.join(directory, 'vercel.json');
        await writeFile(filename, JSON.stringify(config), {mode: 0o600});
        url = vercel(['deploy', '--yes', '--target', selected.target, '--regions', 'fra1', '--local-config', filename,
          '--meta', 'githubDeployment=1', '--meta', `githubCommitRef=${branch}`, '--meta', `githubCommitSha=${sha}`]);
      } finally {
        await rm(directory, {recursive: true, force: true});
      }
      assert.match(url, /^https:\/\/[\w.-]+\.vercel\.app$/);
      const deployment = vercelAPI(`/v13/deployments/${new URL(url).hostname}`);
      assert.equal(deployment.readyState, 'READY', 'Vercel build did not become ready');
      assert.equal(deployment.projectId, project);
      assert.equal(deployment.meta.githubCommitSha, sha);
      assert.equal(deployment.target, selected.target === 'preview' ? null : 'production');
      assert(deployment.alias.includes(selected.domain), 'Expected branch domain was not updated');
      console.log(`PASS: https://${selected.domain} updated to ${sha}`);
      if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
        `Database migrations and contracts passed. Application: https://${selected.domain} (${sha}).\n`);
    },
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(); } catch (error) {
    console.error(`::error::Release blocked: ${error.message}`);
    process.exitCode = 1;
  }
}
