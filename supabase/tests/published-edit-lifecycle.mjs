// Published duty edits across the month lifecycle: repeated and reverted edits,
// extras, pending swaps, stale callers, a planned next month and reopening the
// edited month. The ledger must equal the published history after every step.
// Only synthetic fixtures in an empty disposable LOCAL container; every case rolls back.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {canonicalDuties} from '../../lib/scheduling/calendar.ts';
import {replay} from '../../lib/compensation/index.ts';
import {deriveTransfers} from '../../lib/allocation/derive.ts';
const container=process.argv[2];assert.match(container??'',/^supabase_db_[\w-]+$/);
const ids=Array.from({length:13},(_,i)=>`74000000-0000-0000-0000-${String(i+1).padStart(12,'0')}`);
const manager=ids[0],month='2027-12',next='2028-01',duties=canonicalDuties(month,{});
let weekend=0,weekday=0;
const assignments=Object.fromEntries(duties.map(d=>[d.id,{primary:ids[d.weekendId?weekend++:5+weekday++%7]}]));
const plain=duties.filter(d=>!d.weekendId),[x,y]=[plain[2],plain[3]],a=assignments[x.id].primary,ay=assignments[y.id].primary;
// Weekday members, so the next month can move one weekday duty between them.
const [b,c]=ids.slice(5).filter(id=>![a,ay].includes(id));
// The ordinary minimum-cost baseline, with explicit permanent counterparts to these
// targets. `cover` adds the plan's own Temporary change: b covers a's duty x.
const fair=Object.fromEntries(ids.map(id=>[id,4]));fair[manager]+=duties.reduce((n,d)=>n+d.units,0)-ids.length*4;
function plan(cover) {
 const totals=Object.fromEntries(ids.map(id=>[id,0]));for(const d of duties)totals[assignments[d.id].primary]+=d.units;
 const current={...fair},transfers=[];
 for(const fromId of ids)for(const toId of ids){const n=Math.min(current[fromId]-totals[fromId],totals[toId]-current[toId]);if(n>0){transfers.push({id:'baseline/'+transfers.length,fromId,toId,units:n,kind:'permanent'});current[fromId]-=n;current[toId]+=n}}
 const placed=structuredClone(assignments),targets={...totals};
 if(cover){transfers.push({id:'cover',fromId:a,toId:b,units:x.units,kind:'temporary'});placed[x.id].primary=b;targets[a]-=x.units;targets[b]+=x.units}
 const changes=Object.fromEntries(ids.map(id=>[id,{temporary:0,permanent:0}]));
 for(const t of transfers){changes[t.fromId][t.kind]-=t.units;changes[t.toId][t.kind]+=t.units}
 return {draft:{baselineUnits:{...fair},offeredUnits:{...fair},targetsUnits:targets,repayments:[],changes,pairs:transfers,transfers:deriveTransfers(ids,changes,transfers),sourceKey:'published-edit-lifecycle'},placed};
}
const quote=v=>"'"+JSON.stringify(v).replaceAll("'","''")+"'::jsonb";
const sql=query=>{const r=spawnSync('docker',['exec','-i',container,'psql','-XqAt','-U','postgres','-v','ON_ERROR_STOP=1'],{input:query,encoding:'utf8',maxBuffer:32*1024*1024});assert.equal(r.status,0,r.stderr);return r.stdout.trim().split('\n').filter(x=>x.startsWith('{')).map(JSON.parse)};
const rev='(select revision from public.duty_workspace where id)';
const current=m=>`(select current_publication_id from public.duty_months where month='${m}')`;
const as=id=>`set local request.jwt.claim.sub='${id}';`;
const publish=(m,deadline='2027-11-24')=>`select public.duty_save_schedule(jsonb_build_object('team','[]'::jsonb,'months',jsonb_build_object('${m}',jsonb_build_object('status','draft','deadline','${deadline}','generated',true)),
 'duties',(select jsonb_agg(to_jsonb(a)) from public.duty_assignments a where publication_id is null and day>='${m}-01' and day<'${m===month?next:'2028-02'}-01')),${rev},'${m}');`;
function setup(cover=false) {
 const {draft,placed}=plan(cover);
 return `begin;
do $$begin if exists(select 1 from auth.users) or exists(select 1 from public.duty_members) or exists(select 1 from public.duty_compensation_events) then raise exception 'Requires empty disposable LOCAL';end if;end$$;
create or replace function duty_private.compensation_now() returns bigint language sql volatile set search_path='' as $$select 1822478400000::bigint$$;
insert into auth.users(id,email) values ${ids.map((id,i)=>`('${id}','edit-life-${i}@example.invalid')`).join(',')};
insert into public.duty_members(id,email,name,role,status,active,seniority) values ${ids.map((id,i)=>`('${id}','edit-life-${i}@example.invalid','Fixture ${i}','${i<2?'admin':'engineer'}','approved',true,${i+1})`).join(',')};
insert into public.duty_months(month,deadline) values('${month}','2027-11-24'),('${next}','2027-12-24');
create function pg_temp.must_fail(command text, pattern text) returns void language plpgsql as $$begin
 begin execute command;exception when others then if sqlerrm !~ pattern then raise exception 'Unexpected refusal: %, expected %',sqlerrm,pattern;end if;return;end;
 raise exception 'Unexpected acceptance: %',pattern;
end$$;
${as(manager)}set local role authenticated;
create temp table context(v jsonb);insert into context select public.duty_generation_context('${month}',${rev});
update context set v=public.duty_confirm_allocation('${month}',${quote(draft)},'[]','[]',(v->>'revision')::bigint,v->>'fingerprint');
update context set v=public.duty_save_generation('${month}',${quote(placed)},(v->>'revision')::bigint,v->>'fingerprint',123);
`+publish(month);
}
const failure=(command,pattern)=>`select pg_temp.must_fail($command$${command}$command$,'${pattern}');`;
const edit=(day,primary,{extra=0,kind='temporary',publication=current(month),revision=rev}={})=>
 `select public.duty_edit_published_duty(${publication},'${day}','${primary}',${extra},0,'${kind}',${revision},'');`;
const restore=`select public.duty_restore_publication(${current(month)},${rev});`;
// Every step reports the actual ledger, the end-of-time Team balance and the month's versions.
const report=label=>`reset role;select jsonb_build_object('label','${label}','view',duty_private.compensation_view(duty_private.compensation_state()),
 'final',duty_private.compensation_view(duty_private.compensation_reconcile(duty_private.compensation_state(),4102444800000,false)),
 'versions',(select count(*) from public.duty_publications where month='${month}'),'status',(select status from public.duty_months where month='${month}'),
 'swap',(select status from public.duty_swap_requests),'counterpart',(select other_id from public.duty_swap_requests),
 'contributions',(select coalesce(jsonb_agg(value->>'status'),'[]') from jsonb_each(duty_private.compensation_state()->'contributions')));set local role authenticated;`;
const ordered=v=>{v=structuredClone(v);for(const k of ['members','lots','contributions','settlements','publications'])v[k]?.sort((p,q)=>p.id.localeCompare(q.id));return v};
function run(body,cover=false) {
 const out=sql(setup(cover)+body+'rollback;').filter(r=>r.label);
 // The SQL ledger replays exactly in the TypeScript core after every step.
 for(const r of out)assert.deepEqual(ordered(r.view),ordered(replay(r.view.events)));
 return Object.fromEntries(out.map(r=>[r.label,r]));
}
// Net units at the end of time, only for members who owe or are owed.
const nets=r=>Object.fromEntries(Object.entries(r.final.net).filter(([,n])=>n));
const debt=(debtor,creditor,units)=>({[debtor]:-units,[creditor]:units});

// Repeated, reverted and chained edits: the debt always follows who does the duty.
let r=run(edit(x.id,b)+report('a→b')+edit(x.id,a)+report('back'));
assert.deepEqual(nets(r['a→b']),debt(a,b,2));assert.deepEqual(nets(r.back),{});assert.equal(r.back.versions,3);
r=run(edit(x.id,b)+edit(x.id,a,{kind:'permanent'})+report('back'));
assert.deepEqual(nets(r.back),{},'Permanent back to the owner cancels the earlier Temporary debt');
r=run(edit(x.id,b,{kind:'permanent'})+edit(x.id,a)+report('back')+edit(x.id,b,{kind:'permanent'})+report('again'));
assert.deepEqual(nets(r.back),debt(b,a,2),'after Permanent, b owns the duty; Temporary back makes b owe a');
assert.deepEqual(nets(r.again),{});
r=run(edit(x.id,b)+edit(x.id,c)+report('chain')+edit(x.id,b,{kind:'permanent'})+report('permanent')+edit(x.id,a)+report('owner'));
assert.deepEqual(nets(r.chain),debt(a,c,2));
assert.deepEqual(nets(r.permanent),{},'Permanent from a temporary holder ends the owner’s debt; nobody owes for work not done');
assert.deepEqual(nets(r.owner),debt(b,a,2));
// Extra points: to 0 and back never creates debt; the debt keeps the published points.
r=run(edit(x.id,a,{extra:1})+report('extra')+edit(x.id,a)+report('zero')+edit(x.id,b,{extra:1})+report('moved')+edit(x.id,b)+report('moved zero')+edit(x.id,a,{extra:2})+report('back'));
assert.deepEqual(nets(r.extra),{});assert.deepEqual(nets(r.zero),{});
assert.deepEqual(nets(r.moved),debt(a,b,2));assert.deepEqual(nets(r['moved zero']),debt(a,b,2));assert.deepEqual(nets(r.back),{});
r=run(edit(x.id,a,{extra:1})+edit(x.id,b)+report('moved')+edit(x.id,a,{kind:'permanent'})+report('back'));
assert.deepEqual(nets(r.moved),debt(a,b,2));assert.deepEqual(nets(r.back),{});
// The plan's own Temporary change is bound to one of b's dates: that date's owner is a.
const cover=sql(setup(true)+`reset role;select jsonb_build_object('day',(select i->'capacity'->0->>'date' from public.duty_compensation_events e,
 jsonb_array_elements(e.operation->'after'->'intents') i where i->>'kind'='temporary'));rollback;`)[0].day;
r=run(report('published')+edit(cover,c,{kind:'permanent'})+report('permanent'),true);
assert.deepEqual(nets(r.published),debt(a,b,2));assert.deepEqual(nets(r.permanent),{});
r=run(edit(cover,c)+report('temporary'),true);
assert.deepEqual(nets(r.temporary),debt(a,c,2));
// Elsewhere b's own share moves permanently; the plan's debt stays.
r=run(edit(x.id,c,{kind:'permanent'})+report('own share'),true);
assert.deepEqual(nets(r['own share']),debt(a,b,2));
console.log('PASS: repeated, reverted, chained and extra-point edits keep the ledger equal to who does each duty');

// Stale tabs: a second edit from the same revision or publication is refused by name.
const opened=`create temp table tab as select ${current(month)} publication,${rev} revision;`;
r=run(opened+edit(x.id,b)+failure(edit(y.id,c,{revision:'(select revision from tab)'}),'The team data changed. Refresh and try again.')
 +failure(edit(y.id,c,{publication:'(select publication from tab)'}),'This publication changed. Refresh first.')+edit(y.id,c)+report('tabs'));
assert.equal(r.tabs.versions,3);assert.deepEqual(nets(r.tabs),{...debt(a,b,2),...debt(ay,c,2)});
console.log('PASS: stale revisions and publications from another tab are refused with their reason');

// Pending swaps: an engineer change follows the existing reconcile; new points ask again.
const at=day=>`(select id from public.duty_assignments where publication_id=${current(month)} and day='${day}')`;
const swap=as(a)+`select public.duty_request_swap(${at(x.id)},${at(y.id)},'Swap please',${rev});`+as(ay)+
 `reset role;create temp table request as select id from public.duty_swap_requests;grant select on request to authenticated;set local role authenticated;select public.duty_resolve_swap((select id from request),'accept',${rev});`+as(manager);
const approve=`select public.duty_resolve_swap((select id from request),'approve',${rev});`;
r=run(swap+edit(x.id,b)+report('requester')+failure(approve,'no longer pending'));
assert.equal(r.requester.swap,'invalidated');
r=run(swap+edit(y.id,c)+report('counterpart'));
assert.equal(r.counterpart.swap,'awaiting_engineer');assert.equal(r.counterpart.counterpart,c);
for(const day of [x.id,y.id]) {
 const owner=day===x.id?a:ay;
 r=run(swap+edit(day,owner,{extra:2})+report('extra')+failure(approve,'no longer pending')+report('after'));
 assert.equal(r.extra.swap,'invalidated','consent was given at the earlier points');assert.deepEqual(nets(r.after),{});
}
console.log('PASS: a pending swap is invalidated, re-asked or invalidated for new points; no consent is reused');

// The next month: planned or published, it keeps its version; its plan sees the debt.
function nextMonth(repay) {
 const list=canonicalDuties(next,{}),base=Object.fromEntries(ids.map(id=>[id,4]));base[manager]+=list.reduce((n,d)=>n+d.units,0)-ids.length*4;
 const offered={...base};if(repay){offered[repay[0]]+=repay[2];offered[repay[1]]-=repay[2]}
 const remaining={...offered},chosen={},seen=new Map(ids.map(id=>[id,new Set()]));
 const place=i=>{if(i===list.length)return Object.values(remaining).every(n=>n===0);const d=list[i];
  for(const id of [...ids].sort((p,q)=>remaining[q]-remaining[p]||p.localeCompare(q))){if(remaining[id]<d.units||i&&chosen[list[i-1].id]?.primary===id||d.weekendId&&seen.get(id).size&&!seen.get(id).has(d.weekendId))continue;
   remaining[id]-=d.units;chosen[d.id]={primary:id};if(d.weekendId)seen.get(id).add(d.weekendId);if(place(i+1))return true;if(d.weekendId)seen.get(id).delete(d.weekendId);remaining[id]+=d.units;
  }return false};
 assert.ok(place(0),'constructive next-month fixture');
 const draft={baselineUnits:base,offeredUnits:offered,targetsUnits:{...offered},repayments:[],changes:Object.fromEntries(ids.map(id=>[id,{temporary:0,permanent:0}])),pairs:[],transfers:[],sourceKey:'published-edit-next'};
 const claim=repay?`jsonb_build_array(jsonb_build_object('claim',(select k from jsonb_array_elements(v->'actual'->'claims') k where k->>'debtorId'='${repay[0]}' and k->>'creditorId'='${repay[1]}'),'units',${repay[2]}))`:`'[]'::jsonb`;
 return `update context set v=public.duty_generation_context('${next}',${rev});
update context set v=public.duty_confirm_allocation('${next}',jsonb_set(${quote(draft)},'{repayments}',${claim}),'[]','[]',(v->>'revision')::bigint,v->>'fingerprint');
update context set v=public.duty_save_generation('${next}',${quote(chosen)},(v->>'revision')::bigint,v->>'fingerprint',123);`+publish(next,'2027-12-24');
}
const nextVersion=`reset role;select jsonb_build_object('label','next','view',duty_private.compensation_view(duty_private.compensation_state()),'publication',${current(next)},
 'claims',(select v->'projected'->'claims' from context));set local role authenticated;`;
r=run(nextMonth()+nextVersion+edit(x.id,b)+`update context set v=public.duty_generation_context('${next}',${rev});`+nextVersion.replace("'next'","'after'")+report('edited'));
assert.equal(r.after.publication,r.next.publication,'the next month keeps its published version');
assert.deepEqual(r.after.claims.map(k=>[k.debtorId,k.creditorId,k.units]),[[a,b,2]],'the next month’s plan sees the earlier month’s debt');
assert.deepEqual(nets(r.edited),debt(a,b,2));
// The next month repays the debt; editing the duty back holds that repayment, never charging twice.
for(const kind of ['temporary','permanent']) {
 r=run(edit(x.id,b)+nextMonth([a,b,2])+report('repaying')+edit(x.id,a,{kind})+report('back'));
 assert.deepEqual(r.repaying.contributions,['pending']);assert.deepEqual(nets(r.repaying),{});
 assert.deepEqual(r.back.contributions,['held'],`${kind}: the repayment waits for a debt`);assert.deepEqual(nets(r.back),{});
}
console.log('PASS: a planned or published next month keeps its version; its repayment of a reverted debt is held');

// Reopening the edited month: edits wait for the draft, which republishes unchanged
// without double counting; Cancel Draft restores editing.
r=run(edit(x.id,b)+report('edited')+restore+failure(edit(y.id,c),'Publish or cancel the open draft before editing published duties')
 +publish(month)+report('republished')+edit(x.id,a)+report('back'));
assert.deepEqual(nets(r.republished),debt(a,b,2));assert.equal(r.republished.versions,3);
assert.equal(r.republished.view.events.length,r.edited.view.events.length+1);assert.deepEqual(nets(r.back),{});
r=run(edit(x.id,b,{extra:1})+restore+publish(month)+report('republished'));
assert.deepEqual(nets(r.republished),debt(a,b,2),'extra points keep the reopened plan’s targets');
r=run(edit(x.id,b)+restore+`select public.duty_cancel_draft('${month}',${rev});`+edit(x.id,a,{kind:'permanent'})+report('cancelled'));
assert.equal(r.cancelled.status,'published');assert.deepEqual(nets(r.cancelled),{});
console.log('PASS: a reopened edited month republishes unchanged without double counting; Cancel Draft restores editing');
