// Executes the actual operator SQL using synthetic identities in an EMPTY local Supabase DB.
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';

const container = process.argv[2];
assert.match(container ?? '', /^supabase_db_[\w-]+$/, 'Pass an empty local Supabase DB container');
const id = '50000000-0000-0000-0000-000000000001';
const sql = query => spawnSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-qAt', '-v', 'ON_ERROR_STOP=1'], {input: query, encoding: 'utf8'});
function checked(query) {
  const result = sql(query);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
assert.equal(checked('select (select count(*) from auth.users)+(select count(*) from public.duty_members)'), '0');
const initialRevision = checked('select revision from public.duty_workspace');
const procedure = readFileSync(new URL('../admin/promote-first-admin.sql', import.meta.url), 'utf8').replace(":'auth_user_id'", `'${id}'`);
const denied = (query, message) => {
  const result = sql(query);
  assert.notEqual(result.status, 0, 'Bootstrap unexpectedly succeeded');
  assert.match(result.stderr, message);
};
try {
  denied(procedure, /Expected the verified Google account/);
  checked(`insert into auth.users(id,email,email_confirmed_at,is_anonymous,aud,role)
    values ('${id}','bootstrap@example.invalid',null,false,'authenticated','authenticated');
    insert into public.duty_members(id,email,name) values ('${id}','bootstrap@example.invalid','Synthetic owner');`);
  denied(procedure, /Expected the verified Google account/);
  checked(`update auth.users set email_confirmed_at=now() where id='${id}'`);
  denied(procedure, /Expected the verified Google account/);
  checked(`insert into auth.identities(id,user_id,provider_id,provider,identity_data)
    values (gen_random_uuid(),'${id}','synthetic-owner','google','{"sub":"synthetic-owner"}')`);
  denied(`set role authenticated;\n${procedure}`, /Trusted database operator required/);
  denied(procedure.replace(id, '50000000-0000-0000-0000-000000000002'), /Expected the verified Google account/);
  assert.equal(checked(`select revision from public.duty_workspace`), initialRevision, 'Failed bootstrap changed revision');
  checked(procedure);
  assert.equal(checked(`select role||':'||status||':'||active from public.duty_members where id='${id}'`), 'admin:approved:true');
  assert.equal(checked('select revision from public.duty_workspace'), String(Number(initialRevision)+1));
  denied(procedure, /First-admin bootstrap already completed/);
  console.log('PASS: operator-only bootstrap, identity gates, atomic promotion, revision and one-time refusal');
} finally {
  checked(`begin; delete from public.duty_members where id='${id}'; delete from auth.users where id='${id}';
    update public.duty_workspace set revision=${initialRevision} where id; commit;`);
}
