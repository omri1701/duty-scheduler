// Real independent sessions in isolated application schemas; no hosted URL or
// credentials. Drop only these synthetic schemas/identities after the test.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
const container=process.argv[2];assert.match(container??'',/^supabase_db_[\w-]+$/);
const manager='62000000-0000-0000-0000-000000000001',other='62000000-0000-0000-0000-000000000002';
const schema='duty_comp_race',privateSchema='duty_comp_race_private';
function session(name='comp-test') {
 const child=spawn('docker',['exec','-i','-e',`PGAPPNAME=${name}`,container,'psql','-XqAt','-U','postgres','-v','ON_ERROR_STOP=1']);
 let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
 const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>resolve({code,out:out.trim(),err}))});
 return {child,done,output:()=>out};
}
async function sql(query){const s=session();s.child.stdin.end(query);return s.done}
async function checked(query){const r=await sql(query);assert.equal(r.code,0,r.err);return r.out}
async function until(check){for(let i=0;i<100;i++){if(await check())return;await delay(30)}throw Error('Timed out waiting for a real workspace lock')}
const revision=()=>checked(`select revision from ${schema}.duty_workspace`);
const call=(op,key,rev)=>`begin;set local request.jwt.claim.sub='${manager}';set local role authenticated;select ${schema}.duty_compensation('${JSON.stringify(op)}',${key?"'"+key+"'":'null'},${key?"'Reviewed'":'null'},${rev});commit;`;
const queryState=`select ${privateSchema}.compensation_view(${privateSchema}.compensation_state())`;
assert.equal(await checked('select count(*) from auth.users'),'0','Requires empty disposable LOCAL');
assert.equal(await checked(`select count(*) from pg_namespace where nspname in ('${schema}','${privateSchema}')`),'0');
const bundleResult=spawnSync(process.execPath,['scripts/database-baseline.mjs','--bundle'],{encoding:'utf8'});assert.equal(bundleResult.status,0,bundleResult.stderr);
const bundle=bundleResult.stdout.replaceAll('duty_private',privateSchema).replaceAll('public.',schema+'.');
const frozen=`create or replace function ${privateSchema}.compensation_now() returns bigint language sql volatile set search_path='' as $$select (extract(epoch from (timestamp '2020-01-02 09:00' at time zone 'Asia/Jerusalem'))*1000)::bigint-1$$;`;
try {
 await checked(`begin;create schema ${schema};grant usage on schema ${schema} to authenticated,service_role;${bundle}${frozen}
 insert into auth.users(id,email) values('${manager}','comp-race-manager@example.invalid'),('${other}','comp-race-other@example.invalid');
 insert into ${schema}.duty_members(id,email,name,role,status,active) values('${manager}','comp-race-manager@example.invalid','Manager','admin','approved',true),('${other}','comp-race-other@example.invalid','Other','admin','approved',true);
 set local request.jwt.claim.sub='${manager}';set local role authenticated;
 select ${schema}.duty_compensation('{"kind":"claim","debtorId":"${manager}","creditorId":"${other}","units":4}','debt','Reviewed',0);reset role;
 insert into ${schema}.duty_months(month,deadline) values('2020-01','2019-12-24');
 insert into ${schema}.duty_publications(month,version,published_by) values('2020-01',1,'${manager}');
 insert into ${schema}.duty_assignments(publication_id,day,end_day,primary_id) select id,'2020-01-01','2020-01-02','${manager}' from ${schema}.duty_publications;
 select ${privateSchema}.compensation_publication('2020-01',(select id from ${schema}.duty_publications),jsonb_build_object('fingerprint',md5((${privateSchema}.compensation_state()->'events')::text),'intents','[]'::jsonb,
 'reservations',jsonb_build_array(jsonb_build_object('id','due','capacity',jsonb_build_object('date','2020-01-01','offset',0,'units',2),'claim',${privateSchema}.compensation_slice(${privateSchema}.compensation_state()->'claims'->0,2)))));
 create or replace function ${privateSchema}.compensation_now() returns bigint language sql volatile set search_path='' as $$select floor(extract(epoch from clock_timestamp())*1000)::bigint$$;
 commit;`);
 // Two lazy callers race the same earned work. The manual correction either
 // follows earning in the winning transaction or is rejected as stale in full.
 let rev=await revision();
 const lot=JSON.parse(await checked(queryState)).lots[0].id;
 const results=await Promise.all([sql(call({kind:'reconcile'},null,rev)),sql(call({kind:'correct',lotId:lot,deltaUnits:-1},'correction',rev))]);
 assert.equal(results.filter(r=>r.code===0).length,1);assert.match(results.find(r=>r.code!==0).err,/team data changed/);
 let state=JSON.parse(await checked(queryState));
 assert.equal(state.settlements.length,1);assert.equal(state.events.filter(e=>e.operation.kind==='earned').length,1);
 assert.equal(state.net[manager],results[1].code===0?-1:-2);
 const count=state.events.length;
 await checked(call({kind:'reconcile'},null,await revision()));assert.equal(JSON.parse(await checked(queryState)).events.length,count);
 console.log('PASS: concurrent lazy reconciliation/manual correction earns once, rejects stale loser and preserves exact net');
 // Identical retries serialize successfully even with their original revision.
 rev=await revision();const op={kind:'claim',debtorId:manager,creditorId:other,units:1};
 const duplicates=await Promise.all([sql(call(op,'duplicate',rev)),sql(call(op,'duplicate',rev))]);
 assert.ok(duplicates.every(r=>r.code===0),JSON.stringify(duplicates));
 state=JSON.parse(await checked(queryState));assert.equal(state.events.filter(e=>e.sourceKey.endsWith('/duplicate')).length,1);assert.equal(Number(await revision()),Number(rev)+1);
 console.log('PASS: concurrent identical source retries commit one event and one revision');
 for(const op of [{kind:'claim',debtorId:manager,creditorId:other,units:1},{kind:'reconcile'}]) {
  const holder=session('comp-demotion');let waiting;
  try {
   rev=await revision();holder.child.stdin.write(`begin;select revision from ${schema}.duty_workspace where id for update;\\echo LOCK_HELD\n`);
   await until(()=>holder.output().includes('LOCK_HELD'));
   waiting=session('comp-wait');waiting.child.stdin.end(call(op,op.kind==='claim'?'demoted':null,Number(rev)+1));
   await until(async()=>await checked("select exists(select 1 from pg_stat_activity where application_name='comp-wait' and wait_event_type='Lock')")==='t');
   holder.child.stdin.end(`set local request.jwt.claim.sub='${other}';set local role authenticated;select ${schema}.duty_set_role('${manager}','engineer',${rev});commit;`);
   assert.equal((await holder.done).code,0);const denied=await waiting.done;assert.notEqual(denied.code,0);assert.match(denied.err,/Admin access required/);
   await checked(`begin;set local request.jwt.claim.sub='${other}';set local role authenticated;select ${schema}.duty_set_role('${manager}','admin',${await revision()});commit;`);
   console.log(`PASS: ${op.kind} rechecks manager after a real lock wait with predicted revision`);
  } finally {holder.child.kill();waiting?.child.kill()}
 }
 const holder=session('comp-clock');let waiting;
 try {
  rev=await revision();holder.child.stdin.write(`begin;select revision from ${schema}.duty_workspace where id for update;\\echo LOCK_HELD\n`);await until(()=>holder.output().includes('LOCK_HELD'));
  waiting=session('comp-clock-wait');waiting.child.stdin.end(call({kind:'reconcile'},null,rev));
  await until(async()=>await checked("select exists(select 1 from pg_stat_activity where application_name='comp-clock-wait' and wait_event_type='Lock')")==='t');
  const releasedAt=Date.now();holder.child.stdin.end('commit;');assert.equal((await holder.done).code,0);
  const response=await waiting.done;assert.equal(response.code,0,response.err);assert.ok(JSON.parse(response.out).actualAtMs>=releasedAt);
  console.log('PASS: authoritative compensation time is sampled after acquiring the workspace lock');
 } finally {holder.child.kill();waiting?.child.kill()}
} finally {
 await checked(`begin;drop schema if exists ${schema} cascade;drop schema if exists ${privateSchema} cascade;delete from auth.users where id in ('${manager}','${other}');commit;`);
}
