// Real LOCAL Auth/PostgREST integration. Never accepts a hosted URL or service key.
// Run: pnpm exec node supabase/tests/calendar-rpc.mjs
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createClient} from '@supabase/supabase-js';
import {prepareLocal,LOCAL_PASSWORD} from '../../scripts/local-supabase.mjs';
import {fromSnapshot,schedulePayload} from '../../lib/supabase/snapshot.ts';
import {blocks,dayOf,monthNext,addDays} from '../../lib/rota/engine.ts';

const env=await prepareLocal();
assert.equal(env.SUPABASE_URL,'http://127.0.0.1:48321');
const sql=query=>execFileSync('docker',['exec','-i','supabase_db_duty-scheduler-app','psql','-U','postgres','-qAt','-v','ON_ERROR_STOP=1'],{input:query,encoding:'utf8'}).trim();
const clients=[];
async function login(email) {
 const c=createClient(env.SUPABASE_URL,env.SUPABASE_PUBLISHABLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
 const {data,error}=await c.auth.signInWithPassword({email,password:LOCAL_PASSWORD});assert.ifError(error);
 clients.push(c);return {c,id:data.user.id};
}
const admin=await login('admin@duty.local'),engineer=await login('engineer@duty.local');
const load=async()=>{const r=await admin.c.rpc('duty_load');assert.ifError(r.error);return r.data};
const call=async(name,args)=>{const r=await admin.c.rpc(name,args);assert.ifError(r.error);return r.data};
const initial=await load();
const year=Array.from({length:30},(_,i)=>2200+i).find(y=>dayOf(y+'-12-31')===5);
const month=year+'-12',next=monthNext(month),friday=month+'-31';
assert(!initial.months.some(m=>[month,next].includes(m.month)),'Test months must be unused');
const owner=row=>(dayOf(row.day)===6?addDays(row.day,-1):row.day).slice(0,7);
const fields=rows=>rows.map(row=>{const copy={...row};delete copy.id;delete copy.publication_id;return copy}).sort((a,b)=>a.day.localeCompare(b.day));
// JSON aggregates do not promise an order among equal-day rows or months.
// Compare every field/identity while ignoring only transport array ordering.
const ordered=raw=>Object.fromEntries(Object.entries(raw).map(([key,value])=>[key,Array.isArray(value)?value.toSorted((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))):value]));
const unrelated=raw=>ordered({...raw,revision:0,months:raw.months.filter(m=>m.month!==month),assignments:raw.assignments.filter(a=>a.publication_id!==null || owner(a)!==month)});
let created=false,trigger=false;
try {
 const state=fromSnapshot(initial,admin.id);
 for(const m of [month,next]) {
  state.months[m]={deadline:m+'-01',status:'draft',generated:true};
  for(const b of blocks(m,[],[]))state.assignments[b.id]={primary:admin.id};
 }
 await call('duty_save_schedule',{p_state:schedulePayload(state),p_publish:month,p_revision:initial.revision});created=true;
  let raw=await load();
  const current=raw.months.find(m=>m.month===month).current_publication_id;
  assert.equal(raw.assignments.filter(a=>a.publication_id===null&&owner(a)===month).length,0);
  await call('duty_restore_publication',{p_publication:current,p_revision:raw.revision});
  raw=await load();const draft=fromSnapshot(raw,admin.id);
 draft.splitWeekends=[...(draft.splitWeekends??[]),friday];
 draft.assignments[addDays(friday,1)]={primary:engineer.id};
 draft.assignments[next+'-05']={primary:engineer.id};
 await call('duty_save_schedule',{p_state:schedulePayload(draft),p_publish:null,p_revision:raw.revision});
 raw=await load();
 const before=structuredClone(raw),publication=raw.months.find(m=>m.month===month).current_publication_id;
 const expected=fields(raw.assignments.filter(a=>a.publication_id===publication&&owner(a)===month));
 const denied=await engineer.c.rpc('duty_cancel_draft',{p_month:month,p_revision:raw.revision});assert.equal(denied.error?.code,'42501');
 const stale=await admin.c.rpc('duty_cancel_draft',{p_month:month,p_revision:raw.revision-1});assert.equal(stale.error?.code,'40001');
  sql(`create function duty_private.calendar_rpc_failure() returns trigger language plpgsql set search_path='' as $$begin if NEW.month='${month}' then raise exception 'Injected LOCAL cancellation failure'; end if; return NEW; end$$;
  create trigger calendar_rpc_failure before update on public.duty_months for each row execute function duty_private.calendar_rpc_failure();`);trigger=true;
 const failed=await admin.c.rpc('duty_cancel_draft',{p_month:month,p_revision:raw.revision});assert.equal(failed.error?.message,'Injected LOCAL cancellation failure');
  assert.deepEqual(ordered(await load()),ordered(before),'HTTP failure must roll back deletes and revision');
  sql('drop trigger calendar_rpc_failure on public.duty_months; drop function duty_private.calendar_rpc_failure();');trigger=false;
 const race=await Promise.all([0,1].map(()=>admin.c.rpc('duty_cancel_draft',{p_month:month,p_revision:raw.revision})));
 assert.equal(race.filter(r=>!r.error).length,1);assert.equal(race.find(r=>r.error).error.code,'40001');
 raw=await load();
 assert.equal(raw.months.find(m=>m.month===month).status,'published');
 assert.equal(raw.revision,before.revision+1);
  assert.deepEqual(raw.assignments.filter(a=>a.publication_id===null&&owner(a)===month),[]);
  assert.deepEqual(fields(raw.assignments.filter(a=>a.publication_id===publication)),expected);
 assert.deepEqual(unrelated(raw),unrelated(before),'Other months, immutable rows, history and requests must survive');
  await call('duty_restore_publication',{p_publication:publication,p_revision:raw.revision});
  raw=await load();assert.deepEqual(fields(raw.assignments.filter(a=>a.publication_id===null&&owner(a)===month)),expected);
  console.log('PASS: actual LOCAL Auth/PostgREST Publish/Reopen/Cancel/Reopen, no duplicate published rows, December ownership, revision race, permission denial and atomic failure rollback');
} finally {
  if(trigger)sql('drop trigger calendar_rpc_failure on public.duty_months; drop function duty_private.calendar_rpc_failure();');
 if(created)sql(`begin; select 1 from public.duty_workspace where id for update;
 update public.duty_months set current_publication_id=null where month in ('${month}','${next}');
 delete from public.duty_publications where month in ('${month}','${next}');
 delete from public.duty_assignments where publication_id is null and duty_private.duty_owner(day) in ('${month}','${next}');
 delete from public.duty_months where month in ('${month}','${next}');
 update public.duty_workspace set revision=revision+1 where id; commit;`);
 for(const c of clients)await c.auth.signOut({scope:'local'});
}
