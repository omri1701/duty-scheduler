import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';

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
run(cli, ['db', 'reset', '--local', '--no-seed', '--version', latest, '--yes', ...localArgs]);
const query = sql => run('docker', ['exec', '-i', container, 'psql', '-XqAt', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], sql);
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
run(cli, ['db', 'push', '--local', '--skip-vault', '--yes', ...localArgs]);
assert.equal(query(`select (${rpcSQL}) @> '${previousRPCs.replaceAll("'", "''")}'::jsonb;`),
  't', 'Upgrade removed or changed an existing public RPC signature, named argument or result type');
// Extra nullable/defaulted columns and new rows are valid expansions. All previous
// fixture values must remain present, including private notes and history.
assert.equal(query(`select (${snapshotSQL.trim().replace(/;$/, '')})::jsonb @> '${before.replaceAll("'", "''")}'::jsonb;`),
  't', 'Upgrade changed existing identities, profiles, private notes, history, assignments or revision');
console.log('PASS: incremental upgrade from base preserves synthetic existing data');
// Fresh gates explicitly require empty operational data. Reset ONLY this local DB.
run(cli, ['db', 'reset', '--local', '--no-seed', '--yes', ...localArgs]);
run(process.execPath, ['scripts/database-baseline.mjs', '--verify-local', container]);
