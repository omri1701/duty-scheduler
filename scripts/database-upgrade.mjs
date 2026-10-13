import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {referenceQuery} from './database-contract.mjs';

const [base, container] = process.argv.slice(2);
assert.match(base ?? '', /^[a-f0-9]{40}$/);
assert.match(container ?? '', /^supabase_db_[\w-]+$/, 'Only a disposable LOCAL container is accepted');
const run = (command, args, input) => {
  const result = spawnSync(command, args, {input, encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const latest = run('git', ['ls-tree', '--name-only', base, 'supabase/migrations/']).split('\n').sort().at(-1).split('/').at(-1).slice(0, 14);
assert.match(latest, /^\d{14}$/);
const cli = process.env.SUPABASE_CLI || 'supabase';
const localArgs = process.env.SUPABASE_WORKDIR ? ['--workdir', process.env.SUPABASE_WORKDIR] : [];
const query = (sql, database = 'postgres') => run('docker', ['exec', '-i', container, 'psql', '-XqAt', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1'], sql);
const fingerprintSQL = await readFile('supabase/tests/fingerprint.sql', 'utf8');
const freshFingerprint = query(fingerprintSQL);
const freshReferenceData = JSON.parse(query(referenceQuery));
run(cli, ['db', 'reset', '--local', '--no-seed', '--version', latest, '--yes', ...localArgs]);
query(await readFile('supabase/tests/upgrade-preservation.sql', 'utf8'));
const snapshotSQL = `select jsonb_build_object(
  'users',(select jsonb_agg(to_jsonb(t) order by id) from auth.users t),
  'members',(select jsonb_agg(to_jsonb(t) order by id) from public.duty_members t),
  'notes',(select jsonb_agg(to_jsonb(t) order by member_id,day) from public.duty_constraints t),
  'months',(select jsonb_agg(to_jsonb(t) order by month) from public.duty_months t),
  'publications',(select jsonb_agg(to_jsonb(t) order by id) from public.duty_publications t),
  'duties',(select jsonb_agg(to_jsonb(t) order by id) from public.duty_assignments t),
  'revision',(select revision from public.duty_workspace where id));`;
const before = query(snapshotSQL);
const rpcSQL = `select jsonb_object_agg(p.oid::regprocedure::text, jsonb_build_object(
  'arguments',p.proargnames,'result',pg_get_function_result(p.oid)))
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname like 'duty_%'`;
const previousRPCs = query(rpcSQL);
// Synthetic LOCAL recovery rehearsal. Preserve identities, private notes, history,
// catalog permissions and migration history; never connect to a hosted target.
const restoreDatabase = 'duty_ci_restore';
const backupFile = '/tmp/duty-ci-backup.dump';
try {
  run('docker', ['exec', container, 'pg_dump', '-U', 'postgres', '-d', 'postgres', '--format=custom', '--file', backupFile]);
  run('docker', ['exec', container, 'createdb', '-U', 'postgres', '--template=template0', restoreDatabase]);
  // LOCAL postgres cannot SET ROLE to Supabase-managed owners. Restore as the
  // existing container-only superuser, preserving ownership and grants.
  run('docker', ['exec', container, 'pg_restore', '-U', 'supabase_admin', '-d', restoreDatabase, '--exit-on-error', backupFile]);
  assert.equal(query(snapshotSQL, restoreDatabase), before, 'Restored synthetic data differs');
  assert.equal(query(fingerprintSQL, restoreDatabase), query(fingerprintSQL), 'Restored catalog/RLS/RPC differs');
  const history = 'select version,name from supabase_migrations.schema_migrations order by version';
  assert.equal(query(history, restoreDatabase), query(history), 'Restored migration history differs');
  assert.deepEqual(JSON.parse(query(referenceQuery, restoreDatabase)), JSON.parse(query(referenceQuery)), 'Restored reference data differs');
  console.log('PASS: disposable LOCAL logical backup/restore preserves data, history and database contracts');
} finally {
  run('docker', ['exec', container, 'dropdb', '-U', 'postgres', '--if-exists', restoreDatabase]);
  run('docker', ['exec', container, 'rm', '-f', backupFile]);
}
run(cli, ['db', 'push', '--local', '--skip-vault', '--yes', ...localArgs]);
assert.equal(query(`select (${rpcSQL}) @> '${previousRPCs.replaceAll("'", "''")}'::jsonb;`),
  't', 'Upgrade removed or changed an existing public RPC signature, named argument or result type');
assert.equal(query(fingerprintSQL), freshFingerprint, 'Populated upgrade schema/RLS/RPC differs from fresh replay');
assert.deepEqual(JSON.parse(query(referenceQuery)), freshReferenceData, 'Upgraded static reference data differs from fresh replay');
// Extra nullable/defaulted columns and new rows are valid expansions. All previous
// fixture values must remain present, including private notes and history.
assert.equal(query(`select (${snapshotSQL.trim().replace(/;$/, '')})::jsonb @> '${before.replaceAll("'", "''")}'::jsonb;`),
  't', 'Upgrade changed existing identities, profiles, private notes, history, assignments or revision');
console.log('PASS: incremental upgrade from base preserves synthetic existing data');
// Fresh gates explicitly require empty operational data. Reset ONLY this local DB.
run(cli, ['db', 'reset', '--local', '--no-seed', '--yes', ...localArgs]);
// The initial fresh gate verified canonical SQL; upgraded catalog/reference equality
// above proves the same contract. Do not instantiate canonical schemas a second time.
