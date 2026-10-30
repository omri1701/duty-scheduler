// Real RPC -> browser baseline fit -> checked confirm, inside one rolled-back transaction.
// A 14-day +2 special among 12 engineers cannot split equally; the fitted baseline must be accepted.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readGenerationContext} from '../../lib/supabase/generation.ts';
import {readSnapshot,fromSnapshot,schedulePayload} from '../../lib/supabase/snapshot.ts';
import {proposeAllocation,unevenBaseline} from '../../lib/allocation/index.ts';

const container=process.argv[2];assert.match(container??'',/^supabase_db_[\w-]+$/,'Disposable LOCAL container required');
const db=spawn('docker',['exec','-i',container,'psql','-XqAt','-U','postgres','-v','ON_ERROR_STOP=1'],{stdio:['pipe','pipe','pipe']});
let buffer='',errors='',pending,sequence=0;
db.stderr.on('data',data=>{errors+=data});
db.stdout.on('data',data=>{buffer+=data;const marker=`__fit_${sequence}__`;if(pending&&buffer.includes(marker)){const result=buffer.slice(0,buffer.indexOf(marker));buffer=buffer.slice(buffer.indexOf(marker)+marker.length);const {resolve}=pending;pending=null;resolve(result.trim())}});
db.on('close',code=>{if(pending){pending.reject(Error(`psql exited ${code}: ${errors}`));pending=null}});
function sql(query){assert.ok(pending==null);sequence++;return new Promise((resolve,reject)=>{pending={resolve,reject};db.stdin.write(query+`\n\\echo __fit_${sequence}__\n`)})}
const json=async query=>JSON.parse(await sql(query));
const q=value=>"'"+JSON.stringify(value).replaceAll("'","''")+"'::jsonb";
const rev='(select revision from public.duty_workspace where id)';
const manager='76000000-0000-0000-0000-000000000001',month='2026-11',now=Date.parse('2026-10-26T10:00:00Z');
try {
 await sql(`begin;
 do $$begin if exists(select 1 from auth.users) or exists(select 1 from public.duty_members) then raise exception 'Requires empty disposable LOCAL';end if;end$$;
 create or replace function duty_private.compensation_now() returns bigint language sql volatile set search_path='' as $$select ${now}::bigint$$;
 insert into auth.users(id,email) values('${manager}','manager@example.invalid');
 insert into public.duty_members(id,email,name,role,status,active,seniority) values('${manager}','manager@example.invalid','Manager','admin','approved',true,1);
 set local request.jwt.claim.sub='${manager}';set local role authenticated;
 do $$begin for i in 1..11 loop perform public.duty_add_temporary_member('Engineer '||i,${rev});end loop;end$$;
 select public.duty_save_schedule(${q({team:[],months:{[month]:{status:'draft',deadline:'2026-10-25',generated:false}},duties:[]})},${rev},null);`);
 const state=fromSnapshot(readSnapshot(await json('select public.duty_load();')),manager);
 state.specials=[{id:'holiday',title:'Holiday',start:'2026-11-01',end:'2026-11-15',extra:2}];
 await sql(`select public.duty_save_schedule(${q(schedulePayload(state,month))},${rev},null);`);
 let context=readGenerationContext(await json(`select public.duty_generation_context('${month}',${rev});`));
 assert.equal(context.input.schedule.members.filter(m=>m.eligible).length,12);
 const proposal=proposeAllocation(context.input),ids=context.input.seniority;
 assert.deepEqual(ids.map(id=>proposal.draft.baselineUnits[id]),[...Array(6).fill(8),...Array(6).fill(10)]);
 assert.deepEqual(unevenBaseline(context.input,proposal.draft.baselineUnits).map(u=>u.id),ids.slice(6));
 // The plain equal split is refused by the database's exact partition check.
 const equal=Object.fromEntries(ids.map(id=>[id,9]));
 await sql(`do $$begin perform public.duty_confirm_allocation('${month}',${q({...proposal.draft,baselineUnits:equal,offeredUnits:equal,targetsUnits:equal})},'[]','[]',${context.revision},'${context.fingerprint}');
  raise exception 'equal split accepted';exception when raise_exception then if sqlerrm<>'invalid-ordinary-baseline' then raise;end if;end$$;`);
 context=readGenerationContext(await json(`select public.duty_confirm_allocation('${month}',${q(proposal.draft)},'[]','[]',${context.revision},'${context.fingerprint}');`));
 assert.deepEqual(context.allocation.baselineUnits,proposal.draft.baselineUnits);
 console.log('PASS: the browser-fitted ordinary baseline for indivisible holiday duties is accepted by duty_confirm_allocation; the equal split is refused');
 await sql('rollback;');
} finally {db.stdin.end();}
