// Real PostgreSQL sessions, only an empty disposable LOCAL database.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

const container=process.argv[2];
assert.match(container??'',/^supabase_db_[\w-]+$/);
const manager='40000000-0000-0000-0000-000000000001',other='40000000-0000-0000-0000-000000000002';
const publication='40000000-0000-0000-0000-000000000003';
function session(name='lifecycle-test') {
 const child=spawn('docker',['exec','-i','-e',`PGAPPNAME=${name}`,container,'psql','-XqAt','-U','postgres','-v','ON_ERROR_STOP=1']);
 let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
 const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>resolve({code,out:out.trim(),err}))});
 return {child,done,output:()=>out};
}
async function sql(query) {const s=session();s.child.stdin.end(query);return s.done}
async function checked(query) {const r=await sql(query);assert.equal(r.code,0,r.err);return r.out}
async function until(check) {for(let i=0;i<100;i++){if(await check())return;await delay(25)}throw Error('Timed out waiting for actual database lock')}
const scope=`jsonb_build_object('team','[]'::jsonb,'months','{"2098-12":{"deadline":"2098-11-24","status":"draft","generated":true}}'::jsonb,
 'duties',coalesce((select jsonb_agg(to_jsonb(a)) from public.duty_assignments a where publication_id is null),'[]'::jsonb))`;
const calls={cancel:`public.duty_cancel_draft('2098-12',REV)`,reopen:`public.duty_restore_publication('${publication}',REV)`,
 publish:`public.duty_save_schedule(${scope},REV,'2098-12')`,delete:`public.duty_delete_publication('${publication}',REV)`,
 role:`public.duty_set_role('${other}','engineer',REV)`,review:`public.duty_review_member('${other}','approved',REV)`};
const invoke=(name,revision)=>`begin;set local request.jwt.claim.sub='${manager}';set local role authenticated;select ${calls[name].replace('REV',revision)};commit;`;
async function seed() {
 await checked(`begin;
 do $$begin if exists(select 1 from public.duty_members) or exists(select 1 from auth.users) then raise exception 'Requires an empty disposable database';end if;end$$;
 insert into auth.users(id,email) values('${manager}','race-manager@example.invalid'),('${other}','race-other@example.invalid');
 insert into public.duty_members(id,email,name,role,status,active) values('${manager}','race-manager@example.invalid','Manager','admin','approved',true),('${other}','race-other@example.invalid','Other manager','admin','approved',true);
 insert into public.duty_months(month,deadline,status,publication_sequence) values('2098-12','2098-11-24','draft',1);
 insert into public.duty_publications(id,month,version,published_by) values('${publication}','2098-12',1,'${manager}');
 insert into public.duty_assignments(publication_id,day,end_day,primary_id)
 select '${publication}',d::date,d::date+1,'${manager}' from generate_series('2098-12-01'::date,'2099-01-01'::date,interval '1 day') d where duty_private.duty_owner(d::date)='2098-12';
 insert into public.duty_assignments(day,end_day,primary_id) select day,end_day,primary_id from public.duty_assignments;
 update public.duty_months set current_publication_id='${publication}' where month='2098-12';commit;`);
}
async function clean() {await checked(`begin;
 update public.duty_months set current_publication_id=null where month='2098-12';
 delete from public.duty_assignments where publication_id='${publication}' or publication_id is null and duty_private.duty_owner(day)='2098-12';
 delete from public.duty_publications where month='2098-12';delete from public.duty_months where month='2098-12';
 delete from public.duty_members where id in('${manager}','${other}');delete from auth.users where id in('${manager}','${other}');commit;`)}
const snapshot=`select jsonb_build_object('months',(select jsonb_agg(to_jsonb(m) order by month) from public.duty_months m),
 'rows',(select jsonb_agg(to_jsonb(a) order by id) from public.duty_assignments a),
 'publications',(select jsonb_agg(to_jsonb(p) order by id) from public.duty_publications p));`;
assert.equal(await checked('select count(*) from public.duty_members'),'0');
assert.equal(await checked('select count(*) from auth.users'),'0');
for(const name of Object.keys(calls)) {
 await seed();let holder,waiting;
 try {
  const before=await checked(snapshot),revision=Number(await checked('select revision from public.duty_workspace'));
  holder=session('lifecycle-demotion');
  holder.child.stdin.write("begin;select revision from public.duty_workspace where id for update;\\echo LOCK_HELD\n");
  await until(()=>holder.output().includes('LOCK_HELD'));
  waiting=session(`lifecycle-wait-${name}`);waiting.child.stdin.end(invoke(name,revision+1));
  await until(async()=>await checked(`select exists(select 1 from pg_stat_activity where application_name='lifecycle-wait-${name}' and wait_event_type='Lock')`)==='t');
  // Predicting the post-demotion revision deliberately bypasses stale-revision
  // rejection. Authorization must be checked again after the held lock releases.
  holder.child.stdin.end(`set local request.jwt.claim.sub='${other}';set local role authenticated;select public.duty_set_role('${manager}','engineer',${revision});commit;`);
  assert.equal((await holder.done).code,0);
  const denied=await waiting.done;assert.notEqual(denied.code,0);assert.match(denied.err,/Admin access required/);
  assert.equal(await checked(snapshot),before,'Demoted manager changed lifecycle data');
  assert.equal(Number(await checked('select revision from public.duty_workspace')),revision+1);
  console.log(`PASS: ${name} revalidates manager after waiting for lock, even with predicted revision`);
 } finally {holder?.child.kill();waiting?.child.kill();await clean()}
}
await seed();
try {
 const revision=await checked('select revision from public.duty_workspace');
 const results=await Promise.all([sql(invoke('cancel',revision)),sql(invoke('publish',revision))]);
 assert.equal(results.filter(r=>r.code===0).length,1);assert.match(results.find(r=>r.code!==0).err,/team data changed/);
 assert.equal(await checked('select count(*) from public.duty_assignments where publication_id is null'),'0');
 console.log('PASS: concurrent Publish/Cancel commits one operation, rejects stale loser and leaves no working rows');
} finally {await clean()}
