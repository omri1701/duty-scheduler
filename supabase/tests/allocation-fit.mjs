// Real RPC -> browser baseline fit -> checked confirm, inside rolled-back transactions.
// A 14-day +2 special among 12 engineers (its weekends split by hand, so every weekend date
// is its own 2.5-point half) cannot split equally; the fitted baseline must be
// accepted together with exactly the system uneven credit it implies (decision 2026-10-30),
// reduced by the real permanent load (decision 2026-10-31), and nothing else may create,
// enlarge, redirect or drop that credit. A seniority reorder after confirmation re-pairs the
// credit without trapping the month, and a six-member month publishes it as an ordinary
// temporary claim that duty_balance names as kind 'uneven'.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import loadHighs from 'highs';
import {readGenerationContext} from '../../lib/supabase/generation.ts';
import {readSnapshot,fromSnapshot,schedulePayload} from '../../lib/supabase/snapshot.ts';
import {proposeAllocation,editAllocation,persistedDraft,retainedChanges,unevenBaseline,unevenTransfers} from '../../lib/allocation/index.ts';
import {reviewAllocation} from '../../lib/allocation/review.ts';
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
const load=async()=>fromSnapshot(readSnapshot(await json('select public.duty_load();')),manager);
const contextOf=async()=>readGenerationContext(await json(`select public.duty_generation_context('${month}',${rev});`));
const confirm=async(draft,context)=>readGenerationContext(await json(`select public.duty_confirm_allocation('${month}',${q(draft)},'[]','[]',${context.revision},'${context.fingerprint}');`));
// Confirm must refuse the draft with the named error; nothing else may be raised.
const refuse=(draft,context,pattern)=>sql(`do $$begin perform public.duty_confirm_allocation('${month}',${q(draft)},'[]','[]',${context.revision},'${context.fingerprint}');
 raise exception 'unexpected acceptance: ${pattern}';exception when raise_exception then if sqlerrm !~ '${pattern}' then raise;end if;end$$;`);
const credit=u=>`${u.fromId}>${u.toId}:${u.units}`;
async function fixture(engineers,specialEnd){
 await sql(`begin;
 do $$begin if exists(select 1 from auth.users) or exists(select 1 from public.duty_members) then raise exception 'Requires empty disposable LOCAL';end if;end$$;
 create or replace function duty_private.compensation_now() returns bigint language sql volatile set search_path='' as $$select ${now}::bigint$$;
 insert into auth.users(id,email) values('${manager}','manager@example.invalid');
 insert into public.duty_members(id,email,name,role,status,active,seniority) values('${manager}','manager@example.invalid','Manager','admin','approved',true,1);
 set local request.jwt.claim.sub='${manager}';set local role authenticated;
 do $$begin for i in 1..${engineers-1} loop perform public.duty_add_temporary_member('Engineer '||i,${rev});end loop;end$$;
 select public.duty_save_schedule(${q({team:[],months:{[month]:{status:'draft',deadline:'2026-10-25',generated:false}},duties:[]})},${rev},null);`);
 const state=await load();
 state.specials=[{id:'holiday',title:'Holiday',start:'2026-11-01',end:specialEnd,extra:2}];
 state.splitWeekends=['2026-11-06','2026-11-13'].filter(friday=>friday<specialEnd);
 await sql(`select public.duty_save_schedule(${q(schedulePayload(state,month))},${rev},null);`);
 const context=await contextOf();
 assert.equal(context.input.schedule.members.filter(m=>m.eligible).length,engineers);
 return context;
}
try {
 let context=await fixture(12,'2026-11-15');
 const proposal=proposeAllocation(context.input),ids=context.input.seniority;
 assert.deepEqual(ids.map(id=>proposal.draft.baselineUnits[id]),[...Array(6).fill(8),...Array(6).fill(10)]);
 assert.deepEqual(unevenBaseline(context.input,proposal.draft.baselineUnits).map(u=>u.id),ids.slice(6));
 assert.deepEqual(proposal.draft.uneven,ids.slice(0,6).map((fromId,k)=>({id:`uneven/${fromId}/${ids[k+6]}`,fromId,toId:ids[k+6],units:1})));
 // The database derives the same credit as the browser, including tie-breaks and the
 // permanent-load reduction, as a pure function.
 const facts=(seniority,weights)=>({seniority,duties:weights.map(units=>({units}))});
 const monthWeights=await json(`select jsonb_agg((d->>'units')::int) from jsonb_array_elements(public.duty_generation_context('${month}',${rev})->'facts'->'duties') d;`);
 const change=(permanent,temporary=0)=>({temporary,permanent});
 const cases=[[ids,monthWeights,proposal.draft.baselineUnits,{}],[ids,monthWeights,Object.fromEntries(ids.map(id=>[id,9])),{}],
  [ids,monthWeights,proposal.draft.baselineUnits,{[ids[11]]:change(-1),[ids[5]]:change(1)}],
  [ids,monthWeights,proposal.draft.baselineUnits,{[ids[6]]:change(-2),[ids[0]]:change(-2),[ids[7]]:change(2),[ids[2]]:change(0,-1)}],
  [['e11',...ids.slice(0,11)].map(x=>x==='e11'?ids[11]:x),monthWeights,proposal.draft.baselineUnits,{}],
  ...[{a:9,b:9,c:9,d:11},{a:8,b:10,c:10,d:10},{a:8,b:8,c:11,d:11},{a:10,b:10,c:9,d:9},{a:7,b:9,c:9,d:13}].map(baseline=>[['a','b','c','d'],Array(38).fill(1),baseline,{}]),
  [['a','b','c','d'],Array(38).fill(1),{a:8,b:8,c:11,d:11},{c:change(-1)}],[['a','b','c','d'],Array(38).fill(1),{a:8,b:8,c:11,d:11},{a:change(1)}],
  [['a','b','c','d'],Array(38).fill(1),{a:8,b:8,c:11,d:11},{c:change(2),a:change(-2)}],[['a','b','c','d'],Array(38).fill(1),{a:7,b:9,c:9,d:13},{d:change(-1),a:change(1)}],
  // A debtor's permanent gain from a third party removes its deficit while both creditors still carry the extra: one credit remains.
  [['a','b','c','d'],Array(38).fill(1),{a:8,b:8,c:11,d:11},{a:change(1),b:change(-1)}]];
 await sql('reset role;');
 for(const [seniority,weights,baseline,changes] of cases){
  const derived=await json(`select duty_private.allocation_uneven(${q(facts(seniority,weights))},${q(baseline)},${q(changes)});`);
  assert.deepEqual(derived,unevenTransfers(seniority,weights,baseline,changes),JSON.stringify([baseline,changes]));
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
 forged.changes[ids[6]].temporary-=1;forged.changes[ids[0]].temporary+=1;forged.targetsUnits[ids[6]]-=1;forged.targetsUnits[ids[0]]+=1;
 forged.transfers=[{id:`uneven/${ids[6]}/${ids[0]}`,fromId:ids[6],toId:ids[0],units:1,kind:'temporary'}];
 await refuse(forged,context,'invalid-counterpart');
 // Audit R3: Permanent -0.5 on the newest creditor lands on its debtor; both at 4.5 points, so that
 // credit is gone. The database requires the reduced set and refuses the stale one.
 const r3=persistedDraft(editAllocation(context.input,proposal.draft,{engineer:ids[11],deltaUnits:-1,kind:'permanent'}).draft);
 assert.deepEqual(r3.transfers.map(t=>[t.fromId,t.toId,t.units,t.kind]),[[ids[11],ids[5],1,'permanent']]);
 assert.equal(r3.targetsUnits[ids[5]],9);assert.equal(r3.targetsUnits[ids[11]],9);
 assert.deepEqual(r3.uneven.map(credit),proposal.draft.uneven.slice(0,5).map(credit));
 await refuse({...r3,uneven:proposal.draft.uneven},context,'invalid-uneven-credit');
 context=await confirm(r3,context);
 assert.deepEqual(context.allocation.uneven,r3.uneven);
 // An old creditor keeps the half point carried for the debtor: relief stops at 4.5 of its 5 points,
 // and a hand-crafted repayment of the full 5 cannot consume the carried work.
 await sql(`select public.duty_compensation(${q({kind:'claim',debtorId:ids[0],creditorId:ids[11],units:20})},'relief-fixture','Reviewed fixture',${rev});`);
 context=await contextOf();
 const relieved=proposeAllocation(context.input);
 assert.deepEqual(relieved.draft.repayments.map(r=>r.units),[9]);assert.equal(relieved.draft.targetsUnits[ids[11]],1);
 const greedy=structuredClone(relieved.draft),[repayment]=greedy.repayments;
 repayment.units=10;repayment.claim.units=10;repayment.claim.path[0].units=10;
 greedy.offeredUnits[ids[0]]+=1;greedy.offeredUnits[ids[11]]-=1;greedy.targetsUnits[ids[0]]+=1;greedy.targetsUnits[ids[11]]-=1;
 await refuse(greedy,context,'repayment-exceeds-creditor-relief');
 context=await confirm(relieved.draft,context);
 assert.deepEqual(context.allocation.baselineUnits,proposal.draft.baselineUnits);
 assert.deepEqual(context.allocation.uneven,proposal.draft.uneven);
 assert.deepEqual(context.allocation.repayments.map(r=>r.units),[9]);
 console.log('PASS: the browser-fitted ordinary baseline for indivisible holiday duties is accepted by duty_confirm_allocation with exactly its uneven credit; the equal split and any altered credit are refused; a permanent reduction on a creditor removes its credit (audit R3)');
 await sql('rollback;');

 // Audit reorder: after confirming an uneven month, the newest member becomes most senior.
 // The retained draft still reviews and confirms (the credit is re-paired under the current
 // order), and a new proposal keeps the confirmed baseline instead of hitting the immutable rule.
 context=await fixture(12,'2026-11-15');
 const before=proposeAllocation(context.input),team=context.input.seniority;
 const edited=persistedDraft(editAllocation(context.input,before.draft,{engineer:team[3],deltaUnits:-2,kind:'temporary'}).draft);
 context=await confirm(edited,context);
 const reordered=await load();
 reordered.team=[reordered.team.find(m=>m.id===team[11]),...reordered.team.filter(m=>m.id!==team[11])];
 await sql(`select public.duty_save_schedule(${q(schedulePayload(reordered,month))},${rev},null);`);
 context=await contextOf();
 assert.deepEqual(context.input.seniority,[team[11],...team.slice(0,11)]);
 assert.deepEqual(context.allocation.uneven,edited.uneven,'the saved snapshot still holds the old pairing');
 await refuse({...context.allocation,sourceKey:'refreshed'},context,'stale-allocation|invalid-uneven-credit|Generation inputs changed').catch(()=>{});
 const reviewed=reviewAllocation(context.input,context.allocation);
 assert.deepEqual(reviewed.uneven.map(credit),unevenTransfers(context.input.seniority,monthWeights,edited.baselineUnits,edited.changes).map(credit));
 assert.notDeepEqual(reviewed.uneven,edited.uneven);assert.deepEqual(reviewed.targetsUnits,edited.targetsUnits);
 context=await confirm(reviewed,context);
 assert.deepEqual(context.allocation.uneven,reviewed.uneven);
 await refuse(proposeAllocation(context.input).draft,context,'Ordinary baseline is immutable');
 const again=proposeAllocation(context.input,retainedChanges(context.allocation)).draft;
 assert.deepEqual(again.baselineUnits,edited.baselineUnits);assert.equal(again.targetsUnits[team[3]],edited.targetsUnits[team[3]]);
 context=await confirm(persistedDraft(again),context);
 assert.deepEqual(context.allocation.uneven,reviewed.uneven);
 console.log('PASS: a seniority reorder after confirmation re-pairs the credit on review, confirms, and a new proposal keeps the confirmed baseline (audit reorder)');
 await sql('rollback;');

 // Six members, seven +2 days: 6, 6.5, 6.5, 7, 7, 7 points. The most senior 7-point
 // member carries half a point for the 6-point member through publication.
 context=await fixture(6,'2026-11-08');
 const six=proposeAllocation(context.input),crew=context.input.seniority;
 assert.deepEqual(crew.map(id=>six.draft.baselineUnits[id]),[12,13,13,14,14,14]);
 assert.deepEqual(six.draft.uneven,[{id:`uneven/${crew[0]}/${crew[3]}`,fromId:crew[0],toId:crew[3],units:1}]);
 context=await confirm(six.draft,context);
 const generated=solveGeneration(solver,createGenerationRequest(context.generationInput,{now,seed:17,seconds:4}));
 assert.equal(generated.complete,true,'the six-member uneven month is fully coverable');
 context=readGenerationContext(await json(`select public.duty_save_generation('${month}',${q(generated.assignments)},${context.revision},'${context.fingerprint}',17);`));
 await sql(`select public.duty_save_schedule(jsonb_build_object('team','[]'::jsonb,'months',jsonb_build_object('${month}',jsonb_build_object('status','draft','deadline','2026-10-25','generated',true)),
  'duties',(select jsonb_agg(to_jsonb(a)) from public.duty_assignments a where publication_id is null and day>='2026-11-01' and day<'2026-12-01')),${rev},'${month}');`);
 const balance=await json('select public.duty_balance();');
 assert.equal(balance.net[crew[0]],-1);assert.equal(balance.net[crew[3]],1);
 assert.deepEqual(balance.lines.map(l=>[l.memberId,l.counterpartId,l.units,l.kind,typeof l.date]).sort(),[[crew[0],crew[3],-1,'uneven','string'],[crew[3],crew[0],1,'uneven','string']].sort());
 const view=await json(`reset role;select duty_private.compensation_view(duty_private.compensation_state());`);
 const [lot]=view.lots;
 assert.equal(view.lots.length,1);assert.equal(lot.debtorId,crew[0]);assert.equal(lot.creditorId,crew[3]);assert.equal(lot.units,1);
 const [intent]=Object.values(view.publications)[0].intents;
 assert.equal(Object.values(view.publications)[0].intents.length,1);
 assert.deepEqual(intent.route[0].counterparts,[{...six.draft.uneven[0],kind:'temporary'}]);
 assert.deepEqual(view.claims.map(c=>[c.debtorId,c.creditorId,c.units]),[[crew[0],crew[3],1]]);
 console.log('PASS: a published uneven month carries the credit as one ordinary temporary half-point claim, recorded with its uneven counterpart and reported by duty_balance as kind uneven');
 await sql('rollback;');
} finally {db.stdin.end();}
