import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {validateDatabaseChange} from '../scripts/database-policy.mjs';
import {verifyHistory, historyQuery, referenceQuery} from '../scripts/database-contract.mjs';
import {connectionEnvironment, databasePushInvocation, environments, releaseDatabaseFirst, releaseApplicationDomain, verifyReleaseApproval, validateReleaseCredentials, sanitizeReleaseError, vercelFailure, createVercelAPI} from '../scripts/release.mjs';

const versions = [['20261011212413', 'clean_baseline'], ['20261011212421', 'required_reference_data']];
const history = rows => rows.map(row => row.join('|')).join('\n');
const contract = {migrations: versions, fingerprint: 'expected schema', referenceData: {roles: []}};

test('lifecycle rehearsal rejects a mismatched local reset target before connecting or invoking CLI', () => {
  const result = spawnSync(process.execPath, ['supabase/tests/lifecycle-release.mjs', 'supabase_db_wrong_local_target'], {
    encoding: 'utf8', env: {...process.env, SUPABASE_WORKDIR: '.', SUPABASE_CLI: 'must-not-run-supabase'},
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Local config must match inspected container before any reset\/push/);
  assert.equal(result.stdout, '');
});

function credentialFixture(branch) {
  return {
    SUPABASE_DB_URL: `postgresql://postgres.${environments[branch].ref}:synthetic-password@aws-1-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require`,
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic-key', VERCEL_TOKEN: 'synthetic-token',
    VERCEL_ORG_ID: 'team_pbvqzViC50aeT2kaRNnTYkPt', VERCEL_PROJECT_ID: 'prj_Jl2PBhK8DsvK183rKKWesr0821OY',
  };
}

test('missing Environment secrets fail by name before URL parsing or service calls, without disclosing values', () => {
  for (const branch of Object.keys(environments)) {
    const fixture = credentialFixture(branch);
    for (const name of Object.keys(fixture)) {
      for (const value of [undefined, '', '   ']) {
        assert.throws(() => validateReleaseCredentials({...fixture, [name]: value}, branch), error => {
          assert.equal(error.message, `Missing ${environments[branch].name} Environment secrets: ${name}. Configure them in the selected GitHub Environment and forward secrets from the calling workflow.`);
          for (const secret of Object.values(fixture)) assert(!error.message.includes(secret));
          return true;
        });
      }
    }
    assert.throws(() => validateReleaseCredentials({}, branch), /Missing .* Environment secrets: SUPABASE_DB_URL, SUPABASE_PUBLISHABLE_KEY, VERCEL_TOKEN, VERCEL_ORG_ID, VERCEL_PROJECT_ID/);
    const result = spawnSync(process.execPath, ['scripts/release.mjs'], {encoding: 'utf8', env: {
      ...process.env, ...fixture, SUPABASE_DB_URL: '', RELEASE_BRANCH: branch,
      GITHUB_REF: `refs/heads/${branch}`, GITHUB_EVENT_NAME: 'push', GH_TOKEN: '',
    }});
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Missing .* Environment secrets: SUPABASE_DB_URL/);
    assert(!result.stderr.includes('Invalid SUPABASE_DB_URL'));
    assert.equal(result.stdout, '');
  }
});

test('credential-only preflight accepts each selected environment without network calls or credential output', () => {
  for (const branch of Object.keys(environments)) {
    const fixture = credentialFixture(branch);
    const result = spawnSync(process.execPath, ['scripts/release.mjs', '--credentials-only'], {encoding: 'utf8', env: {
      ...process.env, ...fixture, RELEASE_BRANCH: branch,
      GITHUB_REF: `refs/heads/${branch}`, GITHUB_EVENT_NAME: 'push', GH_TOKEN: '',
    }});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), `PASS: ${environments[branch].name} required secrets are present; database and Vercel project bindings match`);
    assert.equal(result.stderr, '');
    for (const query of ['sslmode=synthetic-private-value', 'sslmode=require&synthetic-private-value=1']) {
      const invalid = {...fixture, SUPABASE_DB_URL: fixture.SUPABASE_DB_URL.replace('sslmode=require', query)};
      const failure = spawnSync(process.execPath, ['scripts/release.mjs', '--credentials-only'], {encoding: 'utf8', env: {
        ...process.env, ...invalid, RELEASE_BRANCH: branch,
        GITHUB_REF: `refs/heads/${branch}`, GITHUB_EVENT_NAME: 'push',
      }});
      assert.equal(failure.status, 1);
      assert.match(failure.stderr, /SUPABASE_DB_URL must include sslmode=require|Unsupported database URL options/);
      assert(!failure.stderr.includes('synthetic-private-value'));
      assert(!failure.stderr.includes('synthetic-password'));
      assert(!failure.stderr.includes(invalid.SUPABASE_DB_URL));
      assert.equal(failure.stdout, '');
    }
    const other = branch === 'develop' ? 'master' : 'develop';
    assert.throws(() => validateReleaseCredentials(fixture, other), /outside the selected Frankfurt environment/);
    for (const name of ['VERCEL_ORG_ID', 'VERCEL_PROJECT_ID', 'SUPABASE_PUBLISHABLE_KEY']) {
      assert.throws(() => validateReleaseCredentials({...fixture, [name]: 'synthetic-private-value'}, branch), error => !error.message.includes('synthetic-private-value'));
    }
  }
});

test('both reusable callers forward secrets while release jobs retain branch, PR and Production gates', () => {
  const workflow = readFileSync('.github/workflows/quality.yml', 'utf8');
  assert(!workflow.includes('deploy-production:'), 'Quality alone must never deploy Production');
  for (const [job, branch] of [['deploy-development', 'develop'], ['deploy-production', 'master']]) {
    const source = branch === 'master' ? readFileSync('.github/workflows/production.yml', 'utf8') : workflow;
    const caller = source.split(`\n  ${job}:`)[1].split(/\n  [\w-]+:/)[0];
    assert.match(caller, /uses: \.\/\.github\/workflows\/deploy\.yml/);
    assert.match(caller, /\n    secrets: inherit/);
    if (branch === 'develop') assert(caller.includes("github.event_name == 'push' || github.event_name == 'workflow_dispatch'"));
    else assert(!source.includes('  push:') && !source.includes('  pull_request:'));
    assert(caller.includes(`github.ref == 'refs/heads/${branch}'`));
    if (branch === 'master') assert(caller.includes("vars.PRODUCTION_DEPLOYMENT_ENABLED == 'true'"));
  }
  const deployment = readFileSync('.github/workflows/deploy.yml', 'utf8').split('\n  deploy:')[1];
  assert(deployment.includes("name: ${{ inputs.branch == 'master' && 'Production' || 'Development' }}"));
  assert(deployment.indexOf('--credentials-only') < deployment.indexOf('uses: pnpm/action-setup'));
});

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
    vercelAPI: (route, options) => {
      if (route === '/v13/deployments/duty-intended.vercel.app') { events.push('deployment'); return deployment; }
      if (options?.method === 'POST') {
        assert.equal(branch, 'develop', 'Production must retain automatic domain assignment');
        assert.equal(route, '/v2/deployments/dpl_intended/aliases');
        assert.deepEqual(options.body, {alias: selected.domain, redirect: null});
        events.push('assign');
        return {alias: selected.domain};
      }
      assert.equal(route, `/v4/aliases/${selected.domain}`);
      events.push('domain');
      return alias;
    },
    verifyApproval: () => events.push('approval'),
  };
  return {args, events, deployment, alias};
}

test('Development explicitly aliases a verified Preview after the final branch gate and reads back its deployment binding', async () => {
  const fixture = domainFixture();
  await releaseApplicationDomain(fixture.args);
  assert.deepEqual(fixture.events, ['deployment', 'approval',
    'assign', 'domain']);
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
    if (stage === 'approval') fixture.args.verifyApproval = () => { throw new Error('Synthetic approval failure'); };
    else {
      const api = fixture.args.vercelAPI;
      fixture.args.vercelAPI = (route, options) => {
        if (options?.method === 'POST') throw new Error('Synthetic alias failure');
        return api(route, options);
      };
    }
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
  fixture.args.verifyApproval = () => assert.fail('Production approval stays in the existing release gates');
  await releaseApplicationDomain(fixture.args);
  assert.deepEqual(fixture.events, ['deployment', 'domain']);
});

test('an alias conflict succeeds only when read-back proves the intended deployment and project', async () => {
  for (const conflict of [false, true]) {
    const fixture = domainFixture();
    if (conflict) fixture.alias.deploymentId = 'dpl_other';
    const api = fixture.args.vercelAPI;
    fixture.args.vercelAPI = (route, options) => {
      if (options?.method === 'POST') throw Object.assign(new Error('Alias already assigned'), {status: 409});
      return api(route, options);
    };
    if (conflict) await assert.rejects(releaseApplicationDomain(fixture.args), /Domain does not point to the intended deployment/);
    else await releaseApplicationDomain(fixture.args);
  }
});

test('Vercel failures retain actionable errors while redacting credentials and discarding unrelated output', () => {
  const env = credentialFixture('develop');
  env.GH_TOKEN = 'synthetic-github-token';
  env.PGPASSWORD = 'synthetic:@/password';
  const input = `\u001b[31mError: alias forbidden; check token scope. ${Object.values(env).join(' ')} ${encodeURIComponent(env.PGPASSWORD)} Bearer unknown-token\u001b[0m\n`;
  const message = vercelFailure({status: 1, stderr: input, stdout: 'private build data'}, env);
  assert.match(message, /Vercel CLI failed \(1\): Authentication\/permission failure/);
  for (const secret of Object.values(env)) assert(!message.includes(secret));
  assert(!message.includes(encodeURIComponent(env.PGPASSWORD)));
  assert(!message.includes('unknown-token'));
  assert(!message.includes('private build data'));
  assert(!message.includes('\n'));
  assert(sanitizeReleaseError('postgresql://user:unknown@host/db', {}).includes('[REDACTED DATABASE URL]'));
  assert.match(vercelFailure({status: null}, {}), /could not start.*inspect Vercel deployment events/);
  const privateBuild = vercelFailure({status: 1, stderr: 'Error: alias forbidden\nBuild Error: private-row-sentinel'}, {});
  assert.match(privateBuild, /Authentication\/permission failure/);
  assert(!privateBuild.includes('private-row-sentinel'));
});

test('Vercel API scopes requests, keeps tokens in headers, and safely reports API/JSON failures', async () => {
  const env = credentialFixture('develop');
  const api = createVercelAPI(env, async (url, options) => {
    assert.equal(url, 'https://api.vercel.com/v2/deployments/dpl_intended/aliases?teamId=team_pbvqzViC50aeT2kaRNnTYkPt');
    assert.equal(options.headers.Authorization, `Bearer ${env.VERCEL_TOKEN}`);
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), {alias: environments.develop.domain, redirect: null});
    return {ok: true, json: async () => ({alias: environments.develop.domain})};
  });
  await api('/v2/deployments/dpl_intended/aliases', {method: 'POST', body: {alias: environments.develop.domain, redirect: null}});
  const forbidden = createVercelAPI(env, async () => ({ok: false, status: 403, json: async () => ({error: {message: `Forbidden token ${env.VERCEL_TOKEN}`}})}));
  await assert.rejects(forbidden('/v4/aliases/domain'), error => error.status === 403 && error.message.includes('Forbidden token [REDACTED]') && !error.message.includes(env.VERCEL_TOKEN));
  const malformed = createVercelAPI(env, async () => ({status: 502, json: async () => { throw new Error('private-response-sentinel'); }}));
  await assert.rejects(malformed('/v4/aliases/domain'), error => error.message.includes('invalid JSON (502)') && !error.message.includes('private-response-sentinel'));
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
