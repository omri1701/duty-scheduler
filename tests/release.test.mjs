import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {validateDatabaseChange} from '../scripts/database-policy.mjs';
import {verifyHistory, historyQuery, referenceQuery} from '../scripts/database-contract.mjs';
import {connectionEnvironment, databasePushInvocation, environments, releaseDatabaseFirst, releaseApplicationDomain, verifyReleaseApproval} from '../scripts/release.mjs';

const versions = [['20261011212413', 'clean_baseline'], ['20261011212421', 'required_reference_data']];
const history = rows => rows.map(row => row.join('|')).join('\n');
const contract = {migrations: versions, fingerprint: 'expected schema', referenceData: {roles: []}};

function domainFixture(branch = 'develop') {
  const selected = environments[branch];
  const events = [];
  const sha = 'a'.repeat(40);
  const url = 'https://duty-intended.vercel.app';
  const projectId = 'prj_Jl2PBhK8DsvK183rKKWesr0821OY';
  const deployment = {id: 'dpl_intended', readyState: 'READY', projectId,
    meta: {githubCommitSha: sha, githubCommitRef: branch}, target: branch === 'develop' ? null : 'production', alias: []};
  const alias = {alias: selected.domain, projectId, deploymentId: deployment.id, redirect: null};
  const args = {branch, sha, url,
    vercelAPI: route => {
      if (route === '/v13/deployments/duty-intended.vercel.app') { events.push('deployment'); return deployment; }
      assert.equal(route, `/v4/aliases/${selected.domain}`);
      events.push('domain');
      return alias;
    },
    verifyApproval: () => events.push('approval'),
    vercel: command => events.push(command),
  };
  return {args, events, deployment, alias};
}

test('Development explicitly aliases a verified Preview after the final branch gate and reads back its deployment binding', async () => {
  const fixture = domainFixture();
  await releaseApplicationDomain(fixture.args);
  assert.deepEqual(fixture.events, ['deployment', 'approval',
    ['alias', 'set', fixture.args.url, environments.develop.domain, '--scope', 'omri1701s-projects'], 'domain']);
  assert.deepEqual(fixture.deployment.alias, [], 'No automatic Git alias assignment is needed');
});

test('unready, unrelated or malformed deployments cannot promote Development', async () => {
  for (const patch of [{readyState: 'BUILDING'}, {readyState: 'ERROR'}, {projectId: 'prj_other'},
    {meta: {githubCommitSha: 'b'.repeat(40), githubCommitRef: 'develop'}},
    {meta: {githubCommitSha: 'a'.repeat(40), githubCommitRef: 'feature/test'}},
    {target: 'production'}, {id: undefined}]) {
    const fixture = domainFixture();
    Object.assign(fixture.deployment, patch);
    await assert.rejects(releaseApplicationDomain(fixture.args));
    assert.deepEqual(fixture.events, ['deployment']);
  }
  for (const patch of [{branch: 'feature/test'}, {url: 'http://duty-intended.vercel.app'}]) {
    const fixture = domainFixture();
    await assert.rejects(releaseApplicationDomain({...fixture.args, ...patch}));
    assert.deepEqual(fixture.events, []);
  }
});

test('a superseded branch or failed alias command cannot complete domain promotion', async () => {
  for (const stage of ['approval', 'alias']) {
    const fixture = domainFixture();
    fixture.args[stage === 'approval' ? 'verifyApproval' : 'vercel'] = () => { throw new Error(`Synthetic ${stage} failure`); };
    await assert.rejects(releaseApplicationDomain(fixture.args), new RegExp(`Synthetic ${stage} failure`));
    assert.deepEqual(fixture.events, stage === 'approval' ? ['deployment'] : ['deployment', 'approval']);
  }
});

test('READY and deployment alias membership cannot hide a stale, redirected or cross-project domain binding', async () => {
  for (const branch of ['develop', 'master']) {
    for (const patch of [{deploymentId: 'dpl_previous'}, {deploymentId: undefined},
      {projectId: 'prj_other'}, {alias: environments[branch === 'develop' ? 'master' : 'develop'].domain},
      {redirect: 'elsewhere.example'}]) {
      const fixture = domainFixture(branch);
      fixture.deployment.alias = [environments[branch].domain];
      Object.assign(fixture.alias, patch);
      await assert.rejects(releaseApplicationDomain(fixture.args));
      assert.equal(fixture.events.at(-1), 'domain');
    }
  }
});

test('Production verifies its automatic domain binding without executing a manual alias command', async () => {
  const fixture = domainFixture('master');
  fixture.args.vercel = () => assert.fail('Production must retain automatic domain assignment');
  fixture.args.verifyApproval = () => assert.fail('Production approval stays in the existing release gates');
  await releaseApplicationDomain(fixture.args);
  assert.deepEqual(fixture.events, ['deployment', 'domain']);
});

test('feature pushes and manual dispatches cannot enter hosted release steps, even with deployment credentials', () => {
  for (const [branch, ref, event, error] of [
    ['feature/new-schema', 'refs/heads/feature/new-schema', 'push', 'Wrong release branch context'],
    ['feature/new-schema', 'refs/heads/feature/new-schema', 'workflow_dispatch', 'Wrong release branch context'],
    ['develop', 'refs/heads/feature/new-schema', 'workflow_dispatch', 'Wrong release branch context'],
    ['develop', 'refs/heads/develop', 'pull_request', 'PRs cannot deploy'],
  ]) {
    const result = spawnSync(process.execPath, ['scripts/release.mjs'], {encoding: 'utf8', env: {
      ...process.env, RELEASE_BRANCH: branch, RELEASE_SHA: 'a'.repeat(40), GITHUB_REF: ref, GITHUB_EVENT_NAME: event,
      GH_TOKEN: 'synthetic', SUPABASE_DB_URL: 'synthetic', VERCEL_TOKEN: 'synthetic',
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic',
    }});
    assert.equal(result.status, 1);
    assert(result.stderr.includes(error));
    assert.equal(result.stdout, '', 'No migration or application deployment step may start');
  }
});

test('history rejects gaps, unknown versions and incomplete application contracts', () => {
  assert.deepEqual(verifyHistory(history(versions), versions), []);
  const future = [...versions, ['20261012150000', 'additive']];
  assert.deepEqual(verifyHistory(history(versions), future), ['20261012150000']);
  assert.throws(() => verifyHistory(history(versions), future, true));
  assert.throws(() => verifyHistory(history(future), versions));
  assert.throws(() => verifyHistory(history([versions[0], ['20261012150000', 'unknown']]), versions));
  assert.throws(() => verifyHistory(history([versions[1]]), versions));
});

test('database changes pair canonical sources, new later migrations and regressions; existing history is immutable', () => {
  const previous = versions.map(([version, name]) => `supabase/migrations/${version}_${name}.sql`);
  const source = {status: 'M', file: 'supabase/schemas/tables/duty_members.sql'};
  const migration = {status: 'A', file: 'supabase/migrations/20261012150000_additive.sql'};
  const regression = {status: 'M', file: 'supabase/tests/access.sql'};
  validateDatabaseChange([source, migration, regression], previous);
  validateDatabaseChange([], previous);
  for (const changes of [[source], [migration], [source, migration], [{...migration, status: 'M'}],
    [{...migration, status: 'D'}], [source, {...migration, file: 'supabase/migrations/20261010150000_older.sql'}, regression]]) {
    assert.throws(() => validateDatabaseChange(changes, previous));
  }
});

test('environment credentials cannot cross projects, regions or transaction poolers', () => {
  for (const selected of Object.values(environments)) {
    const valid = `postgresql://postgres.${selected.ref}:synthetic@aws-1-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require`;
    assert.equal(connectionEnvironment(valid, selected.ref).PGUSER, `postgres.${selected.ref}`);
    const other = selected === environments.master ? environments.develop : environments.master;
    assert.throws(() => connectionEnvironment(valid, other.ref));
    assert.throws(() => connectionEnvironment(valid.replace(':5432/', ':6543/'), selected.ref));
    assert.throws(() => connectionEnvironment(valid.replace('eu-central-1', 'ap-northeast-1'), selected.ref));
    assert.throws(() => connectionEnvironment(valid.replace('?sslmode=require', ''), selected.ref));
  }
  assert.throws(() => connectionEnvironment('invalid-secret-value', environments.master.ref), error => !error.message.includes('invalid-secret-value'));
});

test('no-op verifies contracts without executing SQL migrations; failures block application', async () => {
  for (const failure of [null, 'fingerprint', 'reference']) {
    let deployments = 0;
    const promise = releaseDatabaseFirst({contract, fingerprintSQL: 'fingerprint', push: () => assert.fail('Unexpected migration replay'),
      query: sql => sql === historyQuery ? history(versions) : sql === referenceQuery
        ? JSON.stringify(failure === 'reference' ? {} : contract.referenceData) : failure === 'fingerprint' ? 'drift' : contract.fingerprint,
      deployApplication: () => deployments++});
    if (failure) await assert.rejects(promise); else await promise;
    assert.equal(deployments, failure ? 0 : 1);
  }
});

test('migration failure and missing history block deployment; success strictly orders dry-run, migration, verification and app', async () => {
  for (const failure of [null, 'dry-run', 'migration', 'history']) {
    const events = [];
    const domain = domainFixture();
    let applied = false;
    let deployments = 0;
    const future = {...contract, migrations: [...versions, ['20261012150000', 'additive']]};
    const promise = releaseDatabaseFirst({contract: future, fingerprintSQL: 'fingerprint',
      query: sql => {
        events.push(sql === historyQuery ? 'history' : 'contract');
        if (sql === historyQuery) return history(applied && failure !== 'history' ? future.migrations : versions);
        return sql === referenceQuery ? JSON.stringify(contract.referenceData) : contract.fingerprint;
      },
      push: dryRun => { events.push(dryRun ? 'dry-run' : 'migration');
        if (failure === (dryRun ? 'dry-run' : 'migration')) throw new Error('Synthetic failure');
        if (!dryRun) applied = true;
      },
      deployApplication: async () => { events.push('application'); deployments++; await releaseApplicationDomain(domain.args); },
    });
    if (failure) await assert.rejects(promise); else await promise;
    assert.equal(deployments, failure ? 0 : 1);
    if (failure) assert.deepEqual(domain.events, [], 'Migration failures must block deployment inspection and alias promotion');
    if (!failure) assert.deepEqual(events, ['history', 'dry-run', 'migration', 'history', 'contract', 'contract', 'application']);
  }
});

test('database migration credentials travel only through the subprocess environment', () => {
  const secret = 'synthetic:@/encoded password';
  const pg = connectionEnvironment(`postgresql://postgres.qhndiuahuxczujxxitsm:${encodeURIComponent(secret)}@aws-1-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require`, environments.develop.ref);
  for (const dryRun of [true, false]) {
    const invocation = databasePushInvocation(pg, dryRun);
    assert(!invocation.args.join(' ').includes(secret));
    assert(!invocation.args.join(' ').includes(encodeURIComponent(secret)));
    const url = new URL(invocation.args[invocation.args.indexOf('--db-url') + 1]);
    assert.equal(url.password, '');
    assert.equal(url.username, 'postgres.qhndiuahuxczujxxitsm');
    assert.equal(invocation.env.PGPASSWORD, secret);
    assert.equal(invocation.env.SUPABASE_DB_PASSWORD, secret);
    assert.equal(invocation.args.includes('--dry-run'), dryRun);
  }
});

test('solo Production requires the release PR, protected branch, Environment approval and successful Development', async () => {
  const sha = 'a'.repeat(40);
  const repo = process.env.GITHUB_REPOSITORY;
  const responses = {
    '/git/ref/heads/master': {object: {sha}},
    '/environments/Production': {can_admins_bypass: false, protection_rules: [{type: 'required_reviewers', prevent_self_review: false, reviewers: [{}]}]},
    '/branches/master': {protected: true},
    [`/commits/${sha}/pulls?per_page=100`]: [{number: 1, merged_at: 'date', merge_commit_sha: sha,
      base: {ref: 'master'}, head: {ref: 'develop', sha, repo: {full_name: repo}}}],
    [`/deployments?sha=${sha}&environment=Development&per_page=100`]: [{id: 1}],
    '/deployments/1/statuses?per_page=1': [{state: 'success'}],
  };
  await verifyReleaseApproval(route => responses[route], 'master', sha);
  for (const [route, replacement] of [
    ['/git/ref/heads/master', {object: {sha: 'b'.repeat(40)}}],
    ['/environments/Production', {can_admins_bypass: false, protection_rules: []}],
    ['/environments/Production', {...responses['/environments/Production'], can_admins_bypass: true}],
    ['/branches/master', {protected: false}],
    [`/commits/${sha}/pulls?per_page=100`, []],
    [`/deployments?sha=${sha}&environment=Development&per_page=100`, []],
  ]) await assert.rejects(verifyReleaseApproval(key => key === route ? replacement : responses[key], 'master', sha));
  await assert.rejects(verifyReleaseApproval(() => null, 'feature/test', sha));
});
