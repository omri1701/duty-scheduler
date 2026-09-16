import test from 'node:test';
import assert from 'node:assert/strict';
import {addDays,blocks,dates,demo,generate,totals,unavailable,allKnownBlocks} from '../lib/rota/engine.ts';
function run(s,m='2026-10'){const r=generate(s,m);s.assignments=r.assignments;s.months[m]={deadline:m+'-01',status:'draft',generated:true};return r}
test('a whole weekend has one owner, one point and ends Sunday at 09:00',()=>{const b=blocks('2026-10',[]).find(b=>b.start==='2026-10-02');assert.deepEqual({...b},{id:'2026-10-02',start:'2026-10-02',end:'2026-10-04',points:1,kind:'weekend'});});
test('cross-month weekend is canonical, never split or assigned twice',()=>{const a=blocks('2026-07',[]).find(b=>b.start==='2026-07-31'),b=blocks('2026-08',[]).find(b=>b.start==='2026-07-31');assert.deepEqual(a,b);const s=demo();run(s,'2026-07');const who=s.assignments[a.id].primary;run(s,'2026-08');assert.equal(s.assignments[a.id].primary,who);assert.equal(allKnownBlocks(s).filter(b=>b.id===a.id).length,1)});
test('special consecutive days become one block with manually chosen extra points',()=>{const sp={id:'sp',title:'Holiday',start:'2026-10-05',end:'2026-10-07',extra:2};const bs=blocks('2026-10',[sp]);assert.equal(bs.find(b=>b.id===sp.start).points,3);assert.equal(bs.filter(b=>b.start>sp.start&&b.start<sp.end).length,0);assert.equal(bs.flatMap(b=>dates(b.start,b.end)).length,31)});
test('special blocks crossing months retain identity and weighted totals',()=>{const sp={id:'sp',title:'Holiday',start:'2026-10-30',end:'2026-11-03',extra:2};assert.deepEqual(blocks('2026-10',[sp]).find(b=>b.id===sp.start),blocks('2026-11',[sp]).find(b=>b.id===sp.start));});
test('generation covers every duty, respects unavailability including Saturday, and includes manager',()=>{const s=demo();s.constraints.e0['2026-10-03']='no';const r=run(s);assert.equal(r.warnings.length,0);for(const b of blocks('2026-10',[]))assert.equal(unavailable(b,s.assignments[b.id].primary,s.constraints).length,0);assert.ok(Object.values(s.assignments).some(a=>a.primary==='e0'));const counts=Object.values(totals(s,blocks('2026-10',[])));assert.ok(Math.max(...counts)-Math.min(...counts)<=1,JSON.stringify(counts));});
test('locked manual assignments including explicit overrides remain unchanged',()=>{const s=demo();s.constraints.e0['2026-10-01']='no';s.assignments['2026-10-01']={primary:'e0',secondary:'e1',locked:true,override:true};const before=structuredClone(s.assignments['2026-10-01']);run(s);assert.deepEqual(s.assignments['2026-10-01'],before)});
test('an impossible duty remains unassigned for manager decision',()=>{const s=demo();for(const p of s.team)s.constraints[p.id]['2026-10-01']='no';const r=run(s);assert.ok(r.warnings.includes('2026-10-01'));assert.equal(s.assignments['2026-10-01'].primary,'')});
test('a person away for most of the month can still cover a feasible day',()=>{const s=demo();for(const d of dates('2026-10-01','2026-10-25'))s.constraints.e11[d]='no';run(s);for(const b of blocks('2026-10',[]))if(s.assignments[b.id]?.primary==='e11')assert.ok(b.start>='2026-10-25');assert.ok(Object.values(s.assignments).some(a=>a.primary==='e11'))});
test('fairness carries across months without large imbalance',()=>{const s=demo();s.constraints={};run(s);run(s,'2026-11');const p=Object.values(totals(s,allKnownBlocks(s)));assert.ok(Math.max(...p)-Math.min(...p)<=2,JSON.stringify(p));});
test('a new member is eligible without owing historical duty points',()=>{const s=demo();run(s);s.team.push({id:'new',name:'New engineer',color:'#000',active:true});run(s,'2026-11');const p=totals(s,blocks('2026-11',[]));assert.ok(p.new<=4&&p.new>=1,JSON.stringify(p))});
test('calendar blocks cover each date exactly once throughout a year',()=>{for(let i=1;i<=12;i++){const m='2027-'+String(i).padStart(2,'0'),bs=blocks(m,[]);for(const d of dates(m+'-01',addDays(bs.at(-1).end,0)).filter(d=>d.startsWith(m)))assert.equal(bs.filter(b=>b.start<=d&&d<b.end).length,1,d)}});
test('regenerating preserves emergency cover and never makes it the primary',()=>{const s=demo();s.assignments['2026-10-01']={primary:'e0',secondary:'e1'};run(s);assert.equal(s.assignments['2026-10-01'].secondary,'e1');assert.notEqual(s.assignments['2026-10-01'].primary,'e1')});

import {applyConstraints,swapDraft} from '../lib/rota/engine.ts';
test('fresh seeds produce substantially different fair arrangements',()=>{
 const s=demo(),bs=blocks('2026-10',[]);const schedules=[11,22,33,44,55].map(seed=>generate(s,'2026-10',seed).assignments);
 for(const a of schedules){const counts=Object.values(totals({...s,assignments:a},bs));assert.ok(Math.max(...counts)-Math.min(...counts)<=1);for(const b of bs)assert.equal(unavailable(b,a[b.id].primary,s.constraints).length,0)}
 for(const a of schedules.slice(1)){const changed=bs.filter(b=>a[b.id].primary!==schedules[0][b.id].primary).length;assert.ok(changed>=bs.length/2,`${changed}/${bs.length} changed`)}
});
test('batch constraints save notes, support disconnected dates, and clear both atomically',()=>{
 const s=demo(),before=structuredClone(s),ds=['2026-10-04','2026-10-05','2026-10-12'];
 const next=applyConstraints(s,'e0',ds,'no',' Family trip ');
 for(const d of ds){assert.equal(next.constraints.e0[d],'no');assert.equal(next.constraintNotes.e0[d],'Family trip')}
 assert.deepEqual(s,before);const cleared=applyConstraints(next,'e0',ds,'clear');for(const d of ds){assert.equal(cleared.constraints.e0[d],undefined);assert.equal(cleared.constraintNotes.e0[d],undefined)}
});
test('constraints reject publication and preserve other engineers',()=>{
 const s=demo();s.months['2026-10'].status='published';assert.throws(()=>applyConstraints(s,'e0',['2026-10-07'],'no','trip'),/published/);
 s.months['2026-10'].status='draft';const before=structuredClone(s.constraints.e1);const n=applyConstraints(s,'e0',['2026-10-07'],'prefer');assert.deepEqual(n.constraints.e1,before);
});
function swapFixture(){const s=demo();s.constraints={};s.assignments={'2026-10-01':{primary:'e0',secondary:'e2'},'2026-10-02':{primary:'e1'}};return s}
test('draft swaps move whole weekend primary blocks while leaving emergency cover in place',()=>{
 const s=swapFixture(),original=structuredClone(s);const r=swapDraft(s,'2026-10','2026-10-01','2026-10-02');assert.ok(r.ok);assert.equal(r.assignments['2026-10-01'].primary,'e1');assert.equal(r.assignments['2026-10-01'].secondary,'e2');assert.equal(r.assignments['2026-10-02'].primary,'e0');assert.equal(r.assignments['2026-10-03'],undefined);assert.deepEqual(s,original);
});
test('swaps reject locked, published, cross-month, and duplicate emergency assignments',()=>{
 const s=swapFixture();s.assignments['2026-10-01'].locked=true;assert.equal(swapDraft(s,'2026-10','2026-10-01','2026-10-02').reason,'locked');s.assignments['2026-10-01'].locked=false;s.months['2026-10'].status='published';assert.equal(swapDraft(s,'2026-10','2026-10-01','2026-10-02').reason,'published');s.months['2026-10'].status='draft';assert.equal(swapDraft(s,'2026-10','2026-09-30','2026-10-02').reason,'other-month');s.assignments['2026-10-01'].secondary='e1';assert.equal(swapDraft(s,'2026-10','2026-10-01','2026-10-02').reason,'duplicate');
});
test('swap constraint conflicts require an explicit new override including Saturday',()=>{
 const s=swapFixture();s.constraints={e0:{'2026-10-03':'no'}};const r=swapDraft(s,'2026-10','2026-10-01','2026-10-02');assert.equal(r.reason,'availability');assert.deepEqual(r.conflicts,[{person:'e0',date:'2026-10-03'}]);const approved=swapDraft(s,'2026-10','2026-10-01','2026-10-02',true);assert.ok(approved.ok);assert.equal(approved.assignments['2026-10-02'].override,true);assert.equal(approved.assignments['2026-10-01'].override,undefined);
});
test('swapping differently weighted blocks recalculates points by destination',()=>{
 const s=swapFixture();s.specials=[{id:'sp',title:'Holiday',start:'2026-10-01',end:'2026-10-02',extra:3}];const r=swapDraft(s,'2026-10','2026-10-01','2026-10-02');assert.ok(r.ok);const pts=totals({...s,assignments:r.assignments},blocks('2026-10',s.specials));assert.equal(pts.e1,4);assert.equal(pts.e0,1);assert.equal(pts.e2,4);
});
