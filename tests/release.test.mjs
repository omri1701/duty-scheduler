import test from 'node:test';
import assert from 'node:assert/strict';
import {validateDatabaseChange} from '../scripts/database-policy.mjs';
import {verifyHistory, historyQuery, referenceQuery} from '../scripts/database-contract.mjs';
import {connectionEnvironment, environments, releaseDatabaseFirst, verifyReleaseApproval} from '../scripts/release.mjs';

const versions = [['20261011212413', 'clean_baseline'], ['20261011212421', 'required_reference_data']];
const history = rows => rows.map(row => row.join('|')).join('\n');
const contract = {migrations: versions, fingerprint: 'expected schema', referenceData: {roles: []}};

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
      deployApplication: () => { events.push('application'); deployments++; },
    });
    if (failure) await assert.rejects(promise); else await promise;
    assert.equal(deployments, failure ? 0 : 1);
    if (!failure) assert.deepEqual(events, ['history', 'dry-run', 'migration', 'history', 'contract', 'contract', 'application']);
  }
});

test('Production rejects direct pushes, missing approval gates, stale releases and unreviewed release heads', async () => {
  const sha = 'a'.repeat(40);
  const repo = process.env.GITHUB_REPOSITORY;
  const responses = {
    '/git/ref/heads/master': {object: {sha}},
    '/environments/Production': {protection_rules: [{type: 'required_reviewers', reviewers: [{}]}]},
    [`/commits/${sha}/pulls?per_page=100`]: [{number: 1, merged_at: 'date', merge_commit_sha: sha,
      base: {ref: 'master'}, head: {ref: 'develop', sha, repo: {full_name: repo}}}],
    '/pulls/1/reviews?per_page=100': [{state: 'APPROVED', commit_id: sha, user: {id: 1, login: 'trusted'}}],
    '/collaborators/trusted/permission': {permission: 'write'},
    '/collaborators/outsider/permission': {permission: 'read'},
    [`/deployments?sha=${sha}&environment=Development&per_page=100`]: [{id: 1}],
    '/deployments/1/statuses?per_page=1': [{state: 'success'}],
  };
  await verifyReleaseApproval(route => responses[route], 'master', sha);
  for (const [route, replacement] of [
    ['/git/ref/heads/master', {object: {sha: 'b'.repeat(40)}}],
    ['/environments/Production', {protection_rules: []}],
    [`/commits/${sha}/pulls?per_page=100`, []],
    ['/pulls/1/reviews?per_page=100', []],
    ['/pulls/1/reviews?per_page=100', [{state: 'APPROVED', commit_id: 'old', user: {id: 1, login: 'trusted'}}]],
    ['/pulls/1/reviews?per_page=100', [{state: 'APPROVED', commit_id: sha, user: {id: 2, login: 'outsider'}}]],
    [`/deployments?sha=${sha}&environment=Development&per_page=100`, []],
  ]) await assert.rejects(verifyReleaseApproval(key => key === route ? replacement : responses[key], 'master', sha));
  const outsiderVeto = {state: 'CHANGES_REQUESTED', commit_id: sha, user: {id: 2, login: 'outsider'}};
  await verifyReleaseApproval(key => key === '/pulls/1/reviews?per_page=100'
    ? [...responses[key], outsiderVeto] : responses[key], 'master', sha);
  // A trusted approval on page 2 must supersede the earlier trusted veto.
  await verifyReleaseApproval(key => key === '/pulls/1/reviews?per_page=100'
    ? Array.from({length: 100}, () => ({...outsiderVeto, user: {id: 1, login: 'trusted'}}))
    : key === '/pulls/1/reviews?per_page=100&page=2' ? responses['/pulls/1/reviews?per_page=100'] : responses[key], 'master', sha);
  await assert.rejects(verifyReleaseApproval(() => null, 'feature/test', sha));
});
