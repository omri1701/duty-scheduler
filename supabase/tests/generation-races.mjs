// Independent PostgreSQL sessions in isolated LOCAL schemas. No hosted URLs.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
const container=process.argv[2];assert.match(container??'',/^supabase_db_[\w-]+$/);
const schema='duty_gen_race',privateSchema='duty_gen_race_private';
const manager='74000000-0000-0000-0000-000000000001',other='74000000-0000-0000-0000-000000000002';
function session(name='generation-race'){
 const child=spawn('docker',['exec','-i','-e',`PGAPPNAME=${name}`,container,'psql','-XqAt','-U','postgres','-v','ON_ERROR_STOP=1']);let out='',err='';
 child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
 const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>resolve({code,out:out.trim(),err}))});return {child,done,output:()=>out};
}
async function sql(query){const s=session();s.child.stdin.end(query);return s.done}
async function checked(query){const r=await sql(query);assert.equal(r.code,0,r.err);return r.out}
async function until(check){for(let i=0;i<150;i++){if(await check())return;await delay(25)}throw Error('Timed out waiting for real lock')}
const rev=()=>checked(`select revision from ${schema}.duty_workspace`);
const quote=v=>"'"+JSON.stringify(v).replaceAll("'","''")+"'::jsonb";
const auth=op=>`begin;set local request.jwt.claim.sub='${manager}';set local role authenticated;${op};commit;`;
const context=async()=>JSON.parse(await checked(auth(`select ${schema}.duty_generation_context('2027-12',${await rev()})`)));
const snapshot=()=>checked(`select jsonb_build_object('rows',(select jsonb_agg(to_jsonb(a) order by day) from ${schema}.duty_assignments a),'allocation',(select jsonb_agg(to_jsonb(a)) from ${schema}.duty_allocations a),'events',(select jsonb_agg(to_jsonb(e) order by sequence) from ${schema}.duty_compensation_events e))`);
const bundleResult=spawnSync(process.execPath,['scripts/database-baseline.mjs','--bundle'],{encoding:'utf8'});assert.equal(bundleResult.status,0,bundleResult.stderr);
const bundle=bundleResult.stdout.replaceAll('duty_private',privateSchema).replaceAll('public.',schema+'.');
assert.equal(await checked('select count(*) from auth.users'),'0','Requires empty disposable LOCAL');
assert.equal(await checked(`select count(*) from pg_namespace where nspname in ('${schema}','${privateSchema}')`),'0');
try{
 await checked(`begin;create schema ${schema};grant usage on schema ${schema} to authenticated;${bundle}
 create table ${privateSchema}.test_clock(instant bigint);insert into ${privateSchema}.test_clock values(1822478400000);
 create or replace function ${privateSchema}.compensation_now() returns bigint language sql volatile set search_path='' as $$select instant from ${privateSchema}.test_clock$$;
 insert into auth.users(id,email) values('${manager}','gen-race-manager@example.invalid'),('${other}','gen-race-other@example.invalid');
 insert into ${schema}.duty_members(id,email,name,role,status,active) values('${manager}','gen-race-manager@example.invalid','Manager','admin','approved',true),('${other}','gen-race-other@example.invalid','Other','admin','approved',true);
 insert into ${schema}.duty_months(month,deadline) values('2027-12','2027-11-24');commit;`);
 let captured=await context();const weights=captured.facts.duties.reduce((n,d)=>n+d.units,0),targets={[manager]:Math.ceil(weights/4)*2,[other]:Math.floor(weights/4)*2};
 const draft={baselineUnits:targets,offeredUnits:targets,targetsUnits:targets,repayments:[],transfers:[],pending:[],sourceKey:'race-confirmation'};
 captured=JSON.parse(await checked(auth(`select ${schema}.duty_confirm_allocation('2027-12',${quote(draft)},'[]','[]',${captured.revision},'${captured.fingerprint}')`)));
 const assignments=Object.fromEntries(captured.facts.duties.map(d=>[d.id,{primary:null}]));
 const save=(c,revision=c.revision)=>auth(`select ${schema}.duty_save_generation('2027-12',${quote(assignments)},${revision},'${c.fingerprint}',17)`);
 const results=await Promise.all([sql(save(captured)),sql(save(captured))]);
 assert.equal(results.filter(r=>r.code===0).length,1);assert.match(results.find(r=>r.code!==0).err,/team data changed/);
 assert.equal(Number(await rev()),captured.revision+1);
 console.log('PASS: two generation saves on one captured revision commit exactly one result');
 // Reconciliation without discretionary input can also win this lock; the loser
 // must not replace the captured revision with the newly observed one.
 captured=await context();const before=await snapshot();
 await checked(`update ${privateSchema}.test_clock set instant=${captured.coverageStartMs}`);
 const late=await sql(save(captured));assert.notEqual(late.code,0);assert.match(late.err,/generation-window-closed/);assert.equal(await snapshot(),before);
 await checked(`update ${privateSchema}.test_clock set instant=1822478400000`);
 // A manager is demoted during a real lock wait, with the post-change revision
 // deliberately predicted. The repeated authority check must still deny them.
 for(const kind of ['context','confirm','save']){
  captured=await context();const before=await snapshot(),holder=session('gen-demotion');let waiting;
  try{
   holder.child.stdin.write(`begin;select revision from ${schema}.duty_workspace where id for update;\\echo LOCK_HELD\n`);await until(()=>holder.output().includes('LOCK_HELD'));
   const op=kind==='context'?auth(`select ${schema}.duty_generation_context('2027-12',${captured.revision+1})`):kind==='confirm'?auth(`select ${schema}.duty_confirm_allocation('2027-12',${quote(draft)},'[]','[]',${captured.revision+1},'${captured.fingerprint}')`):save(captured,captured.revision+1);
   waiting=session('gen-wait');waiting.child.stdin.end(op);
   await until(async()=>await checked("select exists(select 1 from pg_stat_activity where application_name='gen-wait' and wait_event_type='Lock')")==='t');
   holder.child.stdin.end(`set local request.jwt.claim.sub='${other}';set local role authenticated;select ${schema}.duty_set_role('${manager}','engineer',${captured.revision});commit;`);
   assert.equal((await holder.done).code,0);const denied=await waiting.done;assert.notEqual(denied.code,0);assert.match(denied.err,/Admin access required/);assert.equal(await snapshot(),before);
   await checked(`begin;set local request.jwt.claim.sub='${other}';set local role authenticated;select ${schema}.duty_set_role('${manager}','admin',${await rev()});commit;`);
   console.log(`PASS: ${kind} rechecks manager authority after a real lock wait, including a predicted revision`);
  }finally{holder.child.kill();waiting?.child.kill()}
 }
 captured=await context();const holder=session('gen-cutoff');let waiting;
 try{
  const before=await snapshot();holder.child.stdin.write(`begin;select revision from ${schema}.duty_workspace where id for update;\\echo LOCK_HELD\n`);await until(()=>holder.output().includes('LOCK_HELD'));
  waiting=session('gen-cutoff-wait');waiting.child.stdin.end(save(captured));
  await until(async()=>await checked("select exists(select 1 from pg_stat_activity where application_name='gen-cutoff-wait' and wait_event_type='Lock')")==='t');
  holder.child.stdin.end(`update ${privateSchema}.test_clock set instant=${captured.coverageStartMs};commit;`);assert.equal((await holder.done).code,0);
  const denied=await waiting.done;assert.notEqual(denied.code,0);assert.match(denied.err,/generation-window-closed/);assert.equal(await snapshot(),before);
  console.log('PASS: cutoff crossed during a workspace-lock wait rejects all draft/ledger changes at equality');
 }finally{holder.child.kill();waiting?.child.kill()}
 await checked(`update ${privateSchema}.test_clock set instant=1822478400000`);
 captured=await context();
 const competing=await Promise.all([sql(save(captured)),sql(auth(`select ${schema}.duty_compensation(${quote({kind:'claim',debtorId:manager,creditorId:other,units:1})},'concurrent-ledger','Reviewed concurrent change',${captured.revision})`))]);
 assert.equal(competing.filter(r=>r.code===0).length,1);assert.match(competing.find(r=>r.code!==0).err,/team data changed/);
 assert.equal(Number(await rev()),captured.revision+1);
 console.log('PASS: generation and a concurrent ledger change serialize on the same revision; the stale loser cannot save');
}finally{
 await checked(`begin;drop schema if exists ${schema} cascade;drop schema if exists ${privateSchema} cascade;delete from auth.users where id in('${manager}','${other}');commit;`);
}
