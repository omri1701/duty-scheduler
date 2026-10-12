// Optional integration regression: an EMPTY disposable local Supabase container.
// node supabase/tests/swap-races.mjs supabase_db_<disposable-project>
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';

const container=process.argv[2];
assert.match(container??'',/^supabase_db_[\w-]+$/,'Pass a disposable local Supabase DB container');
const ids={admin:'30000000-0000-0000-0000-000000000001',a:'30000000-0000-0000-0000-000000000002',b:'30000000-0000-0000-0000-000000000003',c:'30000000-0000-0000-0000-000000000004'};
function sql(query){return new Promise((resolve,reject)=>{
 const child=spawn('docker',['exec','-i',container,'psql','-U','postgres','-qAt','-v','ON_ERROR_STOP=1']);
 let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
 child.on('error',reject);child.on('close',code=>resolve({code,out:out.trim(),err}));child.stdin.end(query);
})}
async function checked(query){const r=await sql(query);assert.equal(r.code,0,r.err);return r.out}
const action=(who,request,verb,revision)=>`begin; set local request.jwt.claim.sub='${ids[who]}'; set local role authenticated;
 select public.duty_resolve_swap('${request}','${verb}',${revision}); select pg_sleep(0.2); commit;`;
async function clean(){await checked(`begin;
 delete from public.duty_swap_requests where month='2098-11';
 update public.duty_months set current_publication_id=null where month='2098-11';
 delete from public.duty_assignments where publication_id in (select id from public.duty_publications where month='2098-11');
 delete from public.duty_publications where month='2098-11'; delete from public.duty_months where month='2098-11';
 delete from public.duty_members where id in (${Object.values(ids).map(id=>`'${id}'`).join(',')});
 delete from auth.users where id in (${Object.values(ids).map(id=>`'${id}'`).join(',')}); commit;`)}
async function seed(){
 await checked(`begin;
 do $$ begin if exists(select 1 from public.duty_members) then raise exception 'Requires an empty disposable database'; end if; end $$;
 insert into auth.users(id,email,email_confirmed_at,is_anonymous,aud,role) values
 ${Object.values(ids).map(id=>`('${id}','${id}@example.invalid',now(),false,'authenticated','authenticated')`).join(',')};
 insert into public.duty_members(id,email,name,role,status,active) values
 ${Object.entries(ids).map(([key,id])=>`('${id}','${id}@example.invalid','Race ${key}','${key==='admin'?'admin':'engineer'}','approved',true)`).join(',')};
 insert into public.duty_months(month,deadline,status,publication_sequence) values('2098-11','2098-10-25','published',1);
 insert into public.duty_publications(month,version,published_by) values('2098-11',1,'${ids.admin}');
 insert into public.duty_assignments(publication_id,day,end_day,primary_id)
 select p.id,v.day::date,v.day::date+1,v.owner::uuid from public.duty_publications p
 cross join (values ('2098-11-03','${ids.a}'),('2098-11-04','${ids.b}'),('2098-11-05','${ids.c}')) v(day,owner) where p.month='2098-11';
 update public.duty_months set current_publication_id=(select id from public.duty_publications where month='2098-11') where month='2098-11';
 set local request.jwt.claim.sub='${ids.a}'; set local role authenticated;
 select public.duty_request_swap((select id from public.duty_assignments where day='2098-11-03'),(select id from public.duty_assignments where day='2098-11-04'),'',(select revision from public.duty_workspace)); commit;`);
 return checked("select id from public.duty_swap_requests where month='2098-11'");
}
// Guard before any setup or cleanup. No hosted URL or credentials are accepted.
assert.equal(await checked('select count(*) from public.duty_members'),'0','Requires an empty disposable database');
for(const loser of ['approve','cancel']){
 let seeded=false;
 try{
  const request=await seed();seeded=true;
  let revision=await checked('select revision from public.duty_workspace');
  await checked(action('b',request,'accept',revision));
  revision=await checked('select revision from public.duty_workspace');
  const results=await Promise.all([sql(action('admin',request,'approve',revision)),sql(action(loser==='cancel'?'a':'admin',request,loser,revision))]);
  assert.equal(results.filter(r=>r.code===0).length,1,'Exactly one concurrent resolution commits');
  assert.match(results.find(r=>r.code!==0).err,/team data changed/,'Loser must fail the revision check');
  const status=await checked(`select status from public.duty_swap_requests where id='${request}'`);
  const publications=await checked("select count(*) from public.duty_publications where month='2098-11'");
  assert.equal(publications,status==='approved'?'2':'1','Only committed approval publishes');
  assert.equal(await checked("select primary_id from public.duty_assignments where day='2098-11-03' and publication_id=(select id from public.duty_publications where month='2098-11' and version=1)"),ids.a,'Original history is immutable');
  console.log(`PASS: approve/${loser} race, one commit, stale loser, immutable history`);
 }finally{if(seeded)await clean()}
}
let seeded=false;
try{
 const request=await seed();seeded=true;
 await checked(`begin; set local request.jwt.claim.sub='${ids.c}'; set local role authenticated;
 select public.duty_request_swap((select id from public.duty_assignments where day='2098-11-05'),(select id from public.duty_assignments where day='2098-11-04'),'',(select revision from public.duty_workspace)); commit;`);
 const competing=await checked(`select id from public.duty_swap_requests where requester_id='${ids.c}'`);
 await checked(action('b',competing,'accept',await checked('select revision from public.duty_workspace')));
 const revision=await checked('select revision from public.duty_workspace');
 const results=await Promise.all([sql(action('b',request,'accept',revision)),sql(action('admin',competing,'approve',revision))]);
 assert.equal(results.filter(r=>r.code===0).length,1);
 assert.match(results.find(r=>r.code!==0).err,/team data changed/);
 if(results[1].code!==0)await checked(action('admin',competing,'approve',await checked('select revision from public.duty_workspace')));
 assert.equal(await checked(`select status||':'||other_id::text||':'||(accepted_by is null)::text from public.duty_swap_requests where id='${request}'`),`awaiting_engineer:${ids.c}:true`);
 console.log('PASS: consent/reassignment race, C must accept, no stale B consent');
}finally{if(seeded)await clean()}
