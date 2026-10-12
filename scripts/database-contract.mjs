import assert from 'node:assert/strict';
import {readFile, readdir, writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

export const historyQuery = 'select version,name from supabase_migrations.schema_migrations order by version;';
// Only static lookup rows; never compare the live workspace revision or operational data.
export const referenceQuery = `select jsonb_build_object(
  'roles', (select jsonb_agg(to_jsonb(t) order by code) from public.duty_roles t),
  'members', (select jsonb_agg(to_jsonb(t) order by code) from public.duty_member_statuses t),
  'months', (select jsonb_agg(to_jsonb(t) order by code) from public.duty_month_statuses t),
  'constraints', (select jsonb_agg(to_jsonb(t) order by code) from public.duty_constraint_types t));`;

export function verifyHistory(actual, expected, complete = false) {
  const rows = actual.trim().split('\n').filter(Boolean).map(line => line.split('|'));
  assert(rows.length >= 2, 'Hosted target must already contain both Frankfurt baselines');
  assert(rows.length <= expected.length, 'Remote migration history is ahead of this application');
  assert.deepEqual(rows, expected.slice(0, rows.length), 'Unknown, renamed or non-prefix migration history; investigate without repair');
  if (complete) assert.equal(rows.length, expected.length, 'Pending migrations remain; application deployment blocked');
  return expected.slice(rows.length).map(([version]) => version);
}

export async function exportContract(query, sha, output, root = 'supabase') {
  assert.match(sha, /^[a-f0-9]{40}$/);
  const migrations = (await readdir(`${root}/migrations`)).filter(name => name.endsWith('.sql')).sort()
    .map(name => { const match = /^(\d{14})_(.+)\.sql$/.exec(name); assert(match); return [match[1], match[2]]; });
  verifyHistory(query(historyQuery), migrations, true);
  const contract = {sha, migrations, fingerprint: query(await readFile(`${root}/tests/fingerprint.sql`, 'utf8')),
    referenceData: JSON.parse(query(referenceQuery))};
  assert(contract.fingerprint.split('\n').length >= 7, 'Missing database contract');
  await writeFile(output, JSON.stringify(contract, null, 2) + '\n');
  return contract;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [container, sha, output] = process.argv.slice(2);
  assert.match(container ?? '', /^supabase_db_[\w-]+$/, 'Export contracts only from disposable LOCAL Supabase');
  await exportContract(sql => {
    const result = spawnSync('docker', ['exec', '-i', container, 'psql', '-XqAt', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], {input: sql, encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }, sha, output);
  console.log('PASS: exported migration, catalog, RLS/RPC and reference-data contract');
}
