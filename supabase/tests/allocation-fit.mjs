// Real RPC -> browser baseline fit -> checked confirm, inside rolled-back transactions.
// A 14-day +2 special among 12 engineers cannot split equally; the fitted baseline must be
// accepted together with exactly the system uneven credit it implies (decision 2026-10-30),
// and nothing else may create, enlarge, redirect or drop that credit. A six-member month then
// publishes it as an ordinary temporary claim that duty_balance names as kind 'uneven'.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import loadHighs from 'highs';
import {readGenerationContext} from '../../lib/supabase/generation.ts';
import {readSnapshot,fromSnapshot,schedulePayload} from '../../lib/supabase/snapshot.ts';
import {proposeAllocation,unevenBaseline,unevenTransfers} from '../../lib/allocation/index.ts';
import {createHighsAdapter,createGenerationRequest,solveGeneration} from '../../lib/scheduling/index.ts';

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
const solver=await createHighsAdapter(loadHighs);
// Confirm must refuse the draft with the named error; nothing else may be raised.
const refuse=(draft,context,pattern)=>sql(`do $$begin perform public.duty_confirm_allocation('${month}',${q(draft)},'[]','[]',${context.revision},'${context.fingerprint}');
 raise exception 'unexpected acceptance: ${pattern}';exception when raise_exception then if sqlerrm !~ '${pattern}' then raise;end if;end$$;`);
async function fixture(engineers,specialEnd){
 await sql(`begin;
 do $$begin if exists(select 1 from auth.users) or exists(select 1 from public.duty_members) then raise exception 'Requires empty disposable LOCAL';end if;end$$;
 create or replace function duty_private.compensation_now() returns bigint language sql volatile set search_path='' as $$select ${now}::bigint$$;
 insert into auth.users(id,email) values('${manager}','manager@example.invalid');
 insert into public.duty_members(id,email,name,role,status,active,seniority) values('${manager}','manager@example.invalid','Manager','admin','approved',true,1);
 set local request.jwt.claim.sub='${manager}';set local role authenticated;
 do $$begin for i in 1..${engineers-1} loop perform public.duty_add_temporary_member('Engineer '||i,${rev});end loop;end$$;
 select public.duty_save_schedule(${q({team:[],months:{[month]:{status:'draft',deadline:'2026-10-25',generated:false}},duties:[]})},${rev},null);`);
 const state=fromSnapshot(readSnapshot(await json('select public.duty_load();')),manager);
 state.specials=[{id:'holiday',title:'Holiday',start:'2026-11-01',end:specialEnd,extra:2}];
 await sql(`select public.duty_save_schedule(${q(schedulePayload(state,month))},${rev},null);`);
 const context=readGenerationContext(await json(`select public.duty_generation_context('${month}',${rev});`));
 assert.equal(context.input.schedule.members.filter(m=>m.eligible).length,engineers);
 return context;
}
try {
 let context=await fixture(12,'2026-11-15');
 const proposal=proposeAllocation(context.input),ids=context.input.seniority;
 assert.deepEqual(ids.map(id=>proposal.draft.baselineUnits[id]),[...Array(6).fill(8),...Array(6).fill(10)]);
 assert.deepEqual(unevenBaseline(context.input,proposal.draft.baselineUnits).map(u=>u.id),ids.slice(6));
 assert.deepEqual(proposal.draft.uneven,ids.slice(0,6).map((fromId,k)=>({id:`uneven/${fromId}/${ids[k+6]}`,fromId,toId:ids[k+6],units:1})));
 // The database derives the same credit as the browser, including tie-breaks, as a pure function.
 const facts=(seniority,weights)=>({seniority,duties:weights.map(units=>({units}))});
 const monthWeights=await json(`select jsonb_agg((d->>'units')::int) from jsonb_array_elements(public.duty_generation_context('${month}',${rev})->'facts'->'duties') d;`);
 const cases=[[ids,monthWeights,proposal.draft.baselineUnits],[ids,monthWeights,Object.fromEntries(ids.map(id=>[id,9]))],
  ...[{a:9,b:9,c:9,d:11},{a:8,b:10,c:10,d:10},{a:8,b:8,c:11,d:11},{a:10,b:10,c:9,d:9},{a:7,b:9,c:9,d:13}].map(baseline=>[['a','b','c','d'],Array(38).fill(1),baseline])];
 await sql('reset role;');
 for(const [seniority,weights,baseline] of cases){
  const derived=await json(`select duty_private.allocation_uneven(${q(facts(seniority,weights))},${q(baseline)});`);
  assert.deepEqual(derived,unevenTransfers(seniority,weights,baseline),JSON.stringify(baseline));
 }
 await sql(`set local role authenticated;`);
 // The plain equal split is refused by the database's exact partition check.
 const equal=Object.fromEntries(ids.map(id=>[id,9]));
 await refuse({...proposal.draft,baselineUnits:equal,offeredUnits:equal,targetsUnits:equal,uneven:[]},context,'invalid-ordinary-baseline');
 // Only the derived credit passes: missing, inflated, redirected or extra entries are refused.
 await refuse({...proposal.draft,uneven:[]},context,'invalid-uneven-credit');
 await refuse({...proposal.draft,uneven:proposal.draft.uneven.map((u,k)=>k?u:{...u,units:2})},context,'invalid-uneven-credit');
 const [first,second,...rest]=proposal.draft.uneven;
 await refuse({...proposal.draft,uneven:[{...first,id:`uneven/${first.fromId}/${second.toId}`,toId:second.toId},{...second,id:`uneven/${second.fromId}/${first.toId}`,toId:first.toId},...rest]},context,'invalid-uneven-credit');
 await refuse({...proposal.draft,uneven:[...proposal.draft.uneven,{id:`uneven/${ids[1]}/${ids[11]}`,fromId:ids[1],toId:ids[11],units:1}]},context,'invalid-uneven-credit');
 await refuse({...proposal.draft,uneven:proposal.draft.uneven.map((u,k)=>k?u:{...u,id:'manual/0'})},context,'invalid-uneven-credit');
 // An ordinary transfer cannot borrow the reserved system identity.
 const forged=structuredClone(proposal.draft);
 forged.transfers=[{id:`uneven/${ids[6]}/${ids[0]}`,fromId:ids[6],toId:ids[0],units:1,kind:'temporary'}];
 forged.targetsUnits[ids[6]]-=1;forged.targetsUnits[ids[0]]+=1;
 await refuse(forged,context,'invalid-counterpart');
 // An old creditor keeps the half point carried for the debtor: relief stops at 4.5 of its 5 points,
 // and a hand-crafted repayment of the full 5 cannot consume the carried work.
 await sql(`select public.duty_compensation(${q({kind:'claim',debtorId:ids[0],creditorId:ids[11],units:20})},'relief-fixture','Reviewed fixture',${rev});`);
 context=readGenerationContext(await json(`select public.duty_generation_context('${month}',${rev});`));
 const relieved=proposeAllocation(context.input);
 assert.deepEqual(relieved.draft.repayments.map(r=>r.units),[9]);assert.equal(relieved.draft.targetsUnits[ids[11]],1);
 const greedy=structuredClone(relieved.draft),[repayment]=greedy.repayments;
 repayment.units=10;repayment.claim.units=10;repayment.claim.path[0].units=10;
 greedy.offeredUnits[ids[0]]+=1;greedy.offeredUnits[ids[11]]-=1;greedy.targetsUnits[ids[0]]+=1;greedy.targetsUnits[ids[11]]-=1;
 await refuse(greedy,context,'repayment-exceeds-creditor-relief');
 context=readGenerationContext(await json(`select public.duty_confirm_allocation('${month}',${q(relieved.draft)},'[]','[]',${context.revision},'${context.fingerprint}');`));
 assert.deepEqual(context.allocation.baselineUnits,proposal.draft.baselineUnits);
 assert.deepEqual(context.allocation.uneven,proposal.draft.uneven);
 assert.deepEqual(context.allocation.repayments.map(r=>r.units),[9]);
 console.log('PASS: the browser-fitted ordinary baseline for indivisible holiday duties is accepted by duty_confirm_allocation with exactly its uneven credit; the equal split and any altered credit are refused');
 await sql('rollback;');

 // Six members, seven +2 days: 6, 6.5, 6.5, 7, 7, 7 points. The most senior 7-point
 // member carries half a point for the 6-point member through publication.
 context=await fixture(6,'2026-11-08');
 const six=proposeAllocation(context.input),team=context.input.seniority;
 assert.deepEqual(team.map(id=>six.draft.baselineUnits[id]),[12,13,13,14,14,14]);
 assert.deepEqual(six.draft.uneven,[{id:`uneven/${team[0]}/${team[3]}`,fromId:team[0],toId:team[3],units:1}]);
 context=readGenerationContext(await json(`select public.duty_confirm_allocation('${month}',${q(six.draft)},'[]','[]',${context.revision},'${context.fingerprint}');`));
 const generated=solveGeneration(solver,createGenerationRequest(context.generationInput,{now,seed:17,seconds:4}));
 assert.equal(generated.complete,true,'the six-member uneven month is fully coverable');
 context=readGenerationContext(await json(`select public.duty_save_generation('${month}',${q(generated.assignments)},${context.revision},'${context.fingerprint}',17);`));
 await sql(`select public.duty_save_schedule(jsonb_build_object('team','[]'::jsonb,'months',jsonb_build_object('${month}',jsonb_build_object('status','draft','deadline','2026-10-25','generated',true)),
  'duties',(select jsonb_agg(to_jsonb(a)) from public.duty_assignments a where publication_id is null and day>='2026-11-01' and day<'2026-12-01')),${rev},'${month}');`);
 const balance=await json('select public.duty_balance();');
 assert.equal(balance.net[team[0]],-1);assert.equal(balance.net[team[3]],1);
 assert.deepEqual(balance.lines.map(l=>[l.memberId,l.counterpartId,l.units,l.kind,typeof l.date]).sort(),[[team[0],team[3],-1,'uneven','string'],[team[3],team[0],1,'uneven','string']].sort());
 const view=await json(`reset role;select duty_private.compensation_view(duty_private.compensation_state());`);
 const [lot]=view.lots;
 assert.equal(view.lots.length,1);assert.equal(lot.debtorId,team[0]);assert.equal(lot.creditorId,team[3]);assert.equal(lot.units,1);
 const [intent]=Object.values(view.publications)[0].intents;
 assert.equal(Object.values(view.publications)[0].intents.length,1);
 assert.deepEqual(intent.route[0].counterparts,[{...six.draft.uneven[0],kind:'temporary'}]);
 assert.deepEqual(view.claims.map(c=>[c.debtorId,c.creditorId,c.units]),[[team[0],team[3],1]]);
 console.log('PASS: a published uneven month carries the credit as one ordinary temporary half-point claim, recorded with its uneven counterpart and reported by duty_balance as kind uneven');
 await sql('rollback;');
} finally {db.stdin.end();}
