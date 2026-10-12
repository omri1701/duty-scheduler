// Real Supabase migration execution with a synthetic application deployment hook.
// The deployed app, hosted projects and custom domains are never touched here.
import assert from 'node:assert/strict';
import {mkdtemp, cp, readFile, readdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {exportContract} from './database-contract.mjs';
import {releaseDatabaseFirst, databasePushInvocation} from './release.mjs';

const container = process.argv[2];
assert.match(container ?? '', /^supabase_db_[\w-]+$/);
const cli = process.env.SUPABASE_CLI || 'supabase';
const localArgs = process.env.SUPABASE_WORKDIR ? ['--workdir', process.env.SUPABASE_WORKDIR] : [];
const run = (command, args, input) => {
  const result = spawnSync(command, args, {input, encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const query = sql => run('docker', ['exec', '-i', container, 'psql', '-XqAt', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], sql);
assert.equal(query('select count(*) from auth.users'), '0', 'Integration verification requires an empty local database');
const directory = await mkdtemp(path.join(tmpdir(), 'duty-release-test-'));
assert(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep));
let deployments = 0;
let pushes = 0;
try {
  await cp(path.join(process.env.SUPABASE_WORKDIR || '.', 'supabase/config.toml'), path.join(directory, 'supabase/config.toml'), {recursive: true});
  await cp('supabase/migrations', path.join(directory, 'supabase/migrations'), {recursive: true});
  // Prove the pinned CLI accepts env-only passwords over an authenticated TCP
  // connection, with a throwaway LOCAL role and a failing wrong-password control.
  const localConfig = await readFile(path.join(directory, 'supabase/config.toml'), 'utf8');
  const port = /\[db\][\s\S]*?\nport\s*=\s*(\d+)/.exec(localConfig)?.[1];
  assert(port);
  query(`CREATE ROLE duty_ci_password_probe LOGIN PASSWORD 'synthetic_ci_only';
    GRANT USAGE, CREATE ON SCHEMA supabase_migrations TO duty_ci_password_probe;
    GRANT SELECT ON ALL TABLES IN SCHEMA supabase_migrations TO duty_ci_password_probe;`);
  try {
    const invocation = databasePushInvocation({PGHOST: '127.0.0.1', PGPORT: port,
      PGUSER: 'duty_ci_password_probe', PGPASSWORD: 'synthetic_ci_only'}, true);
    const urlIndex = invocation.args.indexOf('--db-url') + 1;
    const url = new URL(invocation.args[urlIndex]);
    // The disposable container has no TLS; hosted releases always require TLS.
    url.searchParams.set('sslmode', 'disable');
    invocation.args[urlIndex] = url.href;
    const args = [...invocation.args, '--workdir', directory];
    const check = password => spawnSync(cli, args, {encoding: 'utf8', env: {...process.env,
      PGPASSWORD: password, SUPABASE_DB_PASSWORD: password}});
    assert.notEqual(check('synthetic_wrong').status, 0, 'Wrong-password control must fail');
    const correct = check('synthetic_ci_only');
    assert.equal(correct.status, 0, correct.stderr);
    console.log('PASS: pinned Supabase CLI authenticates using password environment, never password argv');
  } finally {
    query(`REVOKE SELECT ON ALL TABLES IN SCHEMA supabase_migrations FROM duty_ci_password_probe;
      REVOKE USAGE, CREATE ON SCHEMA supabase_migrations FROM duty_ci_password_probe;
      DROP ROLE duty_ci_password_probe;`);
  }
  const contract = await exportContract(query, 'a'.repeat(40), path.join(directory, 'contract.json'));
  const fingerprintSQL = await readFile('supabase/tests/fingerprint.sql', 'utf8');
  const push = dryRun => {
    pushes++;
    run(cli, ['db', 'push', '--local', '--skip-vault', '--yes', '--workdir', directory, ...(dryRun ? ['--dry-run'] : [])]);
  };
  await releaseDatabaseFirst({query, push, contract, fingerprintSQL, deployApplication: () => deployments++});
  assert.equal(pushes, 0, 'No-op release must not replay any migration');
  const addMigration = async (name, sql) => {
    run(cli, ['migration', 'new', name, '--workdir', directory]);
    const file = (await readdir(path.join(directory, 'supabase/migrations'))).find(file => file.endsWith(`_${name}.sql`));
    assert(file);
    await writeFile(path.join(directory, 'supabase/migrations', file), sql);
    const version = file.slice(0, 14);
    // CLI timestamps have second precision; use a different generated timestamp
    // for the next probe by asking the CLI again if necessary.
    assert(!contract.migrations.some(([existing]) => existing === version), 'CLI generated a duplicate version; rerun the isolated test');
    contract.migrations.push([version, name]);
  };
  await addMigration('ci_additive_probe', 'CREATE TABLE duty_private.ci_release_probe (id integer PRIMARY KEY);');
  await releaseDatabaseFirst({query, push, contract, fingerprintSQL, deployApplication: () => {
    assert.equal(query("select to_regclass('duty_private.ci_release_probe') is not null"), 't');
    deployments++;
  }});
  assert.equal(pushes, 2, 'Exactly one dry run and one migration push');
  // Use the CLI to allocate a new version without inventing a migration filename.
  await new Promise(resolve => setTimeout(resolve, 1100));
  await addMigration('ci_failing_probe', 'CREATE TABLE duty_private.ci_should_rollback (id integer); SELECT 1/0;');
  await assert.rejects(releaseDatabaseFirst({query, push, contract, fingerprintSQL, deployApplication: () => deployments++}));
  assert.equal(deployments, 2, 'Failed migration must block the corresponding application deployment');
  assert.equal(query("select to_regclass('duty_private.ci_should_rollback') is null"), 't', 'Failing migration must roll back');
  assert.equal(query(`select count(*) from supabase_migrations.schema_migrations where name='ci_failing_probe'`), '0');
  console.log('PASS: actual additive CLI migration, no-op release, transactional failure and blocked application deployment');
} finally {
  // Reset only the disposable LOCAL database to repository migrations.
  run(cli, ['db', 'reset', '--local', '--no-seed', '--yes', ...localArgs]);
  await rm(directory, {recursive: true, force: true});
}
