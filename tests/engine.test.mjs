import test from 'node:test';
import assert from 'node:assert/strict';
import {addDays,blocks,dates,demo,generate,totals,unavailable,allKnownBlocks,weekendCounts,setWeekendAssignment,migrate,ownerMonth,weekendAssignments,setWeekendAssignments,removeSpecialDates,COLORS} from '../lib/rota/engine.ts';
function run(s,m='2026-10'){const r=generate(s,m);s.assignments=r.assignments;s.months[m]={deadline:m+'-01',status:'draft',generated:true};return r}
test('February 29, 2028 is covered exactly once with normal weekday points',()=>{
 const day='2028-02-29',covering=blocks('2028-02',[]).filter(b=>dates(b.start,b.end).includes(day));
 assert.equal(covering.length,1);
 assert.equal(covering[0].kind,'day');
 assert.equal(covering[0].points,1);
});
test('a whole weekend has one owner, one point and ends Sunday at 09:00',()=>{const b=blocks('2026-10',[]).find(b=>b.start==='2026-10-02');assert.deepEqual({...b},{id:'2026-10-02',start:'2026-10-02',end:'2026-10-04',points:1,kind:'weekend',weekendId:'2026-10-02'});});
test('cross-month weekend is canonical, never split or assigned twice',()=>{const a=blocks('2026-07',[]).find(b=>b.start==='2026-07-31'),b=blocks('2026-08',[]).find(b=>b.start==='2026-07-31');assert.deepEqual(a,b);const s=demo();run(s,'2026-07');const who=s.assignments[a.id].primary;run(s,'2026-08');assert.equal(s.assignments[a.id].primary,who);assert.equal(allKnownBlocks(s).filter(b=>b.id===a.id).length,1)});
test('special dates are independent duties with extra points per day',()=>{const sp={id:'sp',title:'Holiday',start:'2026-10-05',end:'2026-10-07',extra:2};const bs=blocks('2026-10',[sp]);assert.equal(bs.find(b=>b.id===sp.start).points,3);assert.equal(bs.filter(b=>b.start>sp.start&&b.start<sp.end).length,1);assert.equal(bs.flatMap(b=>dates(b.start,b.end)).length,31)});
test('special ranges crossing months create independent daily duties, with the weekend as one holiday duty',()=>{const sp={id:'sp',title:'Holiday',start:'2026-10-30',end:'2026-11-03',extra:2};const oct=blocks('2026-10',[sp]).filter(b=>b.specialId),nov=blocks('2026-11',[sp]).filter(b=>b.specialId);assert.deepEqual(oct.map(b=>[b.id,b.end,b.points]),[['2026-10-30','2026-11-01',5]]);assert.deepEqual(nov.map(b=>b.id),['2026-11-01','2026-11-02']);assert.ok(nov.every(b=>b.points===3));});
test('generation covers every duty, respects unavailability including Saturday, and includes manager',()=>{const s=demo();s.constraints.e0['2026-10-03']='no';const r=run(s);assert.equal(r.warnings.length,0);for(const b of blocks('2026-10',[]))assert.equal(unavailable(b,s.assignments[b.id].primary,s.constraints).length,0);assert.ok(Object.values(s.assignments).some(a=>a.primary==='e0'));const counts=Object.values(totals(s,blocks('2026-10',[])));assert.ok(Math.max(...counts)-Math.min(...counts)<=1,JSON.stringify(counts));});
test('regeneration replaces legacy locked primary assignments',()=>{const s=demo();s.constraints.e0['2026-10-01']='no';s.assignments['2026-10-01']={primary:'e0',secondary:'e1',locked:true,override:true};const before=structuredClone(s.assignments['2026-10-01']);run(s);assert.notEqual(s.assignments['2026-10-01'].primary,before.primary);assert.equal(s.assignments['2026-10-01'].locked,undefined)});
test('an impossible duty remains unassigned for manager decision',()=>{const s=demo();for(const p of s.team)s.constraints[p.id]['2026-10-01']='no';const r=run(s);assert.ok(r.warnings.includes('2026-10-01'));assert.equal(s.assignments['2026-10-01'].primary,'')});
test('a person away for most of the month can still cover a feasible day',()=>{const s=demo();for(const d of dates('2026-10-01','2026-10-25'))s.constraints.e11[d]='no';run(s);for(const b of blocks('2026-10',[]))if(s.assignments[b.id]?.primary==='e11')assert.ok(b.start>='2026-10-25');assert.ok(Object.values(s.assignments).some(a=>a.primary==='e11'))});
test('previous month workloads have no effect on the next generation',()=>{const a=demo(),b=demo();a.constraints={};b.constraints={};run(a);const x=generate(a,'2026-11',123),y=generate(b,'2026-11',123);for(const d of blocks('2026-11',[]).filter(d=>ownerMonth(d)==='2026-11'))assert.deepEqual(x.assignments[d.id],y.assignments[d.id]);});
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

test('weekend normalization preserves different lock states and follows both locked primaries when split',()=>{
 const s=demo();s.specials=[];s.assignments={'2026-07-31':{primary:'e0',secondary:'e2',locked:true}};
 const [fri,sat]=weekendAssignments(s,'2026-07-31');assert.equal(sat.locked,true);
 const split=setWeekendAssignments(s,'2026-07-31',fri,{...sat,primary:'e1'});
 assert.equal(split.assignments['2026-08-01'].locked,true);assert.equal(ownerMonth(blocks('2026-07',[],split.splitWeekends).find(b=>b.id==='2026-08-01')),'2026-07');
 const mixed=setWeekendAssignments(s,'2026-07-31',fri,{...sat,locked:false});
 assert.ok(mixed.splitWeekends.includes('2026-07-31'));assert.equal(mixed.assignments['2026-08-01'].locked,false);
 const merged=setWeekendAssignments(split,'2026-07-31',fri,sat);assert.ok(!merged.splitWeekends.includes('2026-07-31'));assert.equal(merged.assignments['2026-07-31'].locked,true);
});

test('draft swaps require unlocking even when manager exceptions are approved',()=>{
 const s=swapFixture();s.assignments['2026-10-01'].locked=true;
 const before=structuredClone(s.assignments);
 assert.deepEqual(swapDraft(s,'2026-10','2026-10-01','2026-10-02',true),{ok:false,reason:'locked'});
 assert.deepEqual(s.assignments,before);
});
test('swaps reject published, cross-month, and duplicate emergency assignments',()=>{
 const s=swapFixture();s.months['2026-10'].status='published';assert.equal(swapDraft(s,'2026-10','2026-10-01','2026-10-02').reason,'published');s.months['2026-10'].status='draft';assert.equal(swapDraft(s,'2026-10','2026-09-30','2026-10-02').reason,'other-month');s.assignments['2026-10-01'].secondary='e1';assert.equal(swapDraft(s,'2026-10','2026-10-01','2026-10-02').reason,'duplicate');
});
test('swap constraint conflicts require an explicit new override including Saturday',()=>{
 const s=swapFixture();s.constraints={e0:{'2026-10-03':'no'}};const r=swapDraft(s,'2026-10','2026-10-01','2026-10-02');assert.equal(r.reason,'availability');assert.deepEqual(r.conflicts,[{person:'e0',date:'2026-10-03'}]);const approved=swapDraft(s,'2026-10','2026-10-01','2026-10-02',true);assert.ok(approved.ok);assert.equal(approved.assignments['2026-10-02'].override,true);assert.equal(approved.assignments['2026-10-01'].override,undefined);
});
test('swapping differently weighted blocks recalculates points by destination',()=>{
 const s=swapFixture();s.specials=[{id:'sp',title:'Holiday',start:'2026-10-01',end:'2026-10-02',extra:3}];const r=swapDraft(s,'2026-10','2026-10-01','2026-10-02');assert.ok(r.ok);const pts=totals({...s,assignments:r.assignments},blocks('2026-10',s.specials));assert.equal(pts.e1,4);assert.equal(pts.e0,1);assert.equal(pts.e2,0);assert.equal(r.assignments['2026-10-01'].secondary,'e2');
});

test('generation assigns no more than one weekend per engineer',()=>{for(const seed of [1,32,981]){const s=demo();s.assignments=generate(s,'2026-10',seed).assignments;assert.ok(Object.values(weekendCounts(s,'2026-10')).every(n=>n<=1));}});
test('weekend capacity shortage leaves uncovered duty instead of exceeding the cap',()=>{const s=demo();s.team=s.team.slice(0,2);s.constraints={};const r=generate(s,'2026-10');s.assignments=r.assignments;assert.equal(r.warnings.filter(d=>blocks('2026-10',[]).find(b=>b.id===d)?.weekendId).length,3);assert.deepEqual(Object.values(weekendCounts(s,'2026-10')),[1,1]);});
test('manual split preserves untouched half, conserves points, and recombines identical owners',()=>{const s=demo();s.assignments['2026-10-02']={primary:'e0'};const split=setWeekendAssignment(s,'2026-10-02','sat',{primary:'e1'});assert.equal(split.assignments['2026-10-02'].primary,'e0');assert.equal(split.assignments['2026-10-03'].primary,'e1');const bs=blocks('2026-10',[],split.splitWeekends);assert.equal(totals(split,bs).e0,.5);assert.equal(totals(split,bs).e1,.5);assert.equal(bs.find(b=>b.id==='2026-10-03').end,'2026-10-04');const merged=setWeekendAssignment(split,'2026-10-02','fri',{primary:'e1'});assert.equal(merged.splitWeekends.length,0);assert.equal(merged.assignments['2026-10-03'],undefined);assert.equal(totals(merged,blocks('2026-10',[])).e1,1);assert.equal(s.assignments['2026-10-03'],undefined);});
test('split cross-month weekend stays owned by Friday month and survives next generation',()=>{let s=demo();s.months['2026-07']={deadline:'2026-07-01',status:'draft'};s=setWeekendAssignment(s,'2026-07-31','all',{primary:'e0'});s=setWeekendAssignment(s,'2026-07-31','sat',{primary:'e1'});const b=blocks('2026-07',[],s.splitWeekends).find(b=>b.id==='2026-08-01');assert.equal(ownerMonth(b),'2026-07');const next=generate(s,'2026-08');assert.deepEqual(next.assignments['2026-08-01'],s.assignments['2026-08-01']);});
test('a special weekend stays one combined duty; every holiday date adds its own extra, combined or split by hand',()=>{let s=demo();s.specials=[{id:'sp',start:'2026-10-02',end:'2026-10-04',extra:2,title:'Holiday'}];s=setWeekendAssignment(s,'2026-10-02','all',{primary:'e0'});const bs=blocks('2026-10',s.specials,s.splitWeekends).filter(b=>b.specialId);assert.deepEqual(bs.map(b=>[b.id,b.end,b.points,b.kind,b.specialDates]),[['2026-10-02','2026-10-04',5,'special',['2026-10-02','2026-10-03']]]);assert.equal(weekendCounts(s,'2026-10').e0,1);
 const halves=blocks('2026-10',s.specials,['2026-10-02']).filter(b=>b.specialId);assert.deepEqual(halves.map(b=>[b.id,b.points,b.specialDates]),[['2026-10-02',2.5,['2026-10-02']],['2026-10-03',2.5,['2026-10-03']]]);
 const half=blocks('2026-10',[{...s.specials[0],extra:0.5}],['2026-10-02']).filter(b=>b.specialId);assert.deepEqual(half.map(b=>[b.id,b.points]),[['2026-10-02',1],['2026-10-03',1]]);
 // A range touching one weekend date adds its extra to that date alone, combined or split by
 // hand, and splitting never changes the total.
 for(const [range,friday,saturday,label] of [[{start:'2026-10-03',end:'2026-10-05'},0,1,'Saturday only'],[{start:'2026-10-01',end:'2026-10-03'},1,0,'Friday only'],[{start:'2026-10-02',end:'2026-10-04'},1,1,'both']]){
  const sp=[{id:'r',extra:1.5,title:'Range',...range}],combined=blocks('2026-10',sp).find(b=>b.id==='2026-10-02');
  assert.deepEqual([combined.points,combined.kind,combined.specialId,combined.specialDates],[1+1.5*(friday+saturday),'special','r',[...(friday?['2026-10-02']:[]),...(saturday?['2026-10-03']:[])]],label);
  const halves=blocks('2026-10',sp,['2026-10-02']).filter(b=>b.weekendId==='2026-10-02');
  assert.deepEqual(halves.map(b=>[b.id,b.points,b.specialId,b.kind]),[['2026-10-02',0.5+1.5*friday,friday?'r':undefined,friday?'special':'weekend'],['2026-10-03',0.5+1.5*saturday,saturday?'r':undefined,saturday?'special':'weekend']],label);
  assert.equal(halves[0].points+halves[1].points,combined.points,label);
 }});
test('removing extra points from one duty cuts each covering range around that duty\'s dates and keeps the weekend shape',()=>{
 const s={...demo(),specials:[{id:'sp',title:'Holiday',start:'2026-10-01',end:'2026-10-08',extra:2}]};
 const weekend=blocks('2026-10',s.specials).find(b=>b.id==='2026-10-02');assert.equal(weekend.points,5);
 const r=removeSpecialDates(s,weekend);
 assert.deepEqual(r.specials.map(x=>[x.start,x.end,x.extra,x.title]),[['2026-10-01','2026-10-02',2,'Holiday'],['2026-10-04','2026-10-08',2,'Holiday']]);
 assert.deepEqual(r.splitWeekends,s.splitWeekends);assert.deepEqual(r.assignments,s.assignments);
 const plain=blocks('2026-10',r.specials).find(b=>b.id==='2026-10-02');assert.deepEqual([plain.points,plain.kind,plain.end],[1,'weekend','2026-10-04']);
 // A hand-split Saturday half loses only its own date; Friday keeps its extra and the split stays.
 const split={...s,splitWeekends:['2026-10-02']},sat=blocks('2026-10',split.specials,split.splitWeekends).find(b=>b.id==='2026-10-03');assert.equal(sat.points,2.5);
 const r2=removeSpecialDates(split,sat);
 assert.deepEqual(r2.specials.map(x=>[x.start,x.end]),[['2026-10-01','2026-10-03'],['2026-10-04','2026-10-08']]);
 const after=blocks('2026-10',r2.specials,r2.splitWeekends);
 assert.equal(after.find(b=>b.id==='2026-10-02').points,2.5);assert.deepEqual([after.find(b=>b.id==='2026-10-03').points,after.find(b=>b.id==='2026-10-03').kind],[0.5,'weekend']);
 assert.deepEqual(removeSpecialDates(r2,after.find(b=>b.id==='2026-10-03')).specials,r2.specials,'a duty without extra is unchanged');
 // A one-day range disappears entirely.
 const one={...demo(),specials:[{id:'d',title:'Day',start:'2026-10-06',end:'2026-10-07',extra:1}]};
 assert.deepEqual(removeSpecialDates(one,blocks('2026-10',one.specials).find(b=>b.id==='2026-10-06')).specials,[]);
});
test('migration keeps notes and assigns each old special day without retaining hidden locks',()=>{const s=demo();s.version=1;s.specials=[{id:'sp',title:'Holiday',start:'2026-10-05',end:'2026-10-07',extra:2}];s.assignments['2026-10-05']={primary:'e0',locked:true};s.constraintNotes={e0:{'2026-10-04':'Trip'}};const n=migrate(s);assert.equal(n.version,3);assert.equal(n.assignments['2026-10-06'].primary,'e0');assert.equal(n.assignments['2026-10-05'].locked,undefined);assert.deepEqual(n.constraintNotes,s.constraintNotes);assert.deepEqual(migrate(n),n);});
test('swaps cannot create a second weekend for an engineer',()=>{const s=swapFixture();s.assignments['2026-10-09']={primary:'e0'};assert.equal(swapDraft(s,'2026-10','2026-10-01','2026-10-02').reason,'weekend-limit');});

test('manager approval reports and persists second and third weekend exceptions with availability',()=>{
 for(const existing of [1,2]){
  const s=swapFixture();s.assignments['2026-10-09']={primary:'e0',override:true};
  if(existing===2)s.assignments['2026-10-16']={primary:'e0',override:true};
  s.constraints={e0:{'2026-10-03':'no'}};
  const original=structuredClone(s),preview=swapDraft(s,'2026-10','2026-10-01','2026-10-02');
  assert.equal(preview.ok,false);assert.deepEqual(preview.weekendConflicts,[{person:'e0',count:existing+1,month:'2026-10'}]);
  assert.deepEqual(preview.conflicts,[{person:'e0',date:'2026-10-03'}]);
  const approved=swapDraft(s,'2026-10','2026-10-01','2026-10-02',true);
  assert.equal(approved.ok,true);assert.equal(weekendCounts({...s,assignments:approved.assignments},'2026-10').e0,existing+1);
  assert.equal(approved.assignments['2026-10-02'].override,true);assert.deepEqual(approved.assignments['2026-10-09'],s.assignments['2026-10-09']);assert.deepEqual(s,original);
 }
});

test('weekend-only approval marks the destination and retains existing assignment overrides',()=>{
 const s=swapFixture();s.assignments['2026-10-09']={primary:'e0'};s.assignments['2026-10-01'].override=true;
 const r=swapDraft(s,'2026-10','2026-10-01','2026-10-02',true);
 assert.ok(r.ok);assert.equal(r.assignments['2026-10-02'].override,true);assert.equal(r.assignments['2026-10-01'].override,true);
 // Exchanging weekdays leaves an existing approved weekend count unchanged.
 s.assignments['2026-10-02']={primary:'e0',override:true};s.assignments['2026-10-05']={primary:'e1'};
 assert.ok(swapDraft(s,'2026-10','2026-10-01','2026-10-05').ok);
});

test('swap counts distinct split/special weekends including emergency cover and Friday month ownership',()=>{
 const s=swapFixture();s.splitWeekends=['2026-10-02'];s.assignments['2026-10-03']={primary:'e0'};
 assert.ok(swapDraft(s,'2026-10','2026-10-01','2026-10-02').ok); // Both halves still count once.
 s.assignments['2026-10-09']={primary:'e3',secondary:'e0',override:true};
 s.specials=[{id:'special',title:'Special',start:'2026-10-02',end:'2026-10-04',extra:2}];
 const r=swapDraft(s,'2026-10','2026-10-01','2026-10-02',true);assert.ok(r.ok);assert.deepEqual(r.weekendConflicts,[]);
 // Same count: e0 already owned Oct 2 via Saturday, so no new approval is needed.
 const boundary=demo();boundary.constraints={};boundary.months['2026-07']={status:'draft',deadline:'2026-07-01'};
 boundary.splitWeekends=['2026-07-31'];boundary.assignments={'2026-07-24':{primary:'e0'},'2026-07-30':{primary:'e0'},'2026-08-01':{primary:'e1'}};
 assert.deepEqual(swapDraft(boundary,'2026-07','2026-07-30','2026-08-01').weekendConflicts,[{person:'e0',count:2,month:'2026-07'}]);
 assert.equal(swapDraft(boundary,'2026-08','2026-07-30','2026-08-01',true).reason,'other-month');
});

test('manager override cannot bypass structural swap failures',()=>{
 for(const kind of ['published','other-month','unassigned','inactive','missing-primary','inactive-secondary','missing-secondary','duplicate','same-duty']){
  const s=swapFixture();let from='2026-10-01',to='2026-10-02';
  if(kind==='published')s.months['2026-10'].status='published';
  if(kind==='other-month')to='invalid';
  if(kind==='unassigned')s.assignments[to].primary='';
  if(kind==='inactive')s.team[1].active=false;
  if(kind==='missing-primary')s.assignments[to].primary='missing';
  if(kind==='inactive-secondary')s.team[2].active=false;
  if(kind==='missing-secondary')s.assignments[from].secondary='missing';
  if(kind==='duplicate')s.assignments[from].secondary='e1';
  if(kind==='same-duty')to=from;
  assert.equal(swapDraft(s,'2026-10',from,to,true).ok,false,kind);
 }
});

test('one approval reports both engineers when split weekend swaps increase both counts',()=>{
 const s=demo();s.constraints={};s.splitWeekends=['2026-10-02','2026-10-09'];
 s.assignments={'2026-10-02':{primary:'e0'},'2026-10-03':{primary:'e0'},'2026-10-09':{primary:'e1'},'2026-10-10':{primary:'e1'}};
 const preview=swapDraft(s,'2026-10','2026-10-02','2026-10-09');
 assert.deepEqual(preview.weekendConflicts,[{person:'e0',count:2,month:'2026-10'},{person:'e1',count:2,month:'2026-10'}]);
 const approved=swapDraft(s,'2026-10','2026-10-02','2026-10-09',true);assert.ok(approved.ok);
 assert.equal(approved.assignments['2026-10-02'].override,true);assert.equal(approved.assignments['2026-10-09'].override,true);
});

test('weekend editor expands a combined assignment and saves two distinct owners atomically',()=>{const s=demo();s.assignments['2026-10-02']={primary:'e0',secondary:'e2'};const [fri,sat]=weekendAssignments(s,'2026-10-02');assert.deepEqual(fri,sat);assert.notEqual(fri,sat);const next=setWeekendAssignments(s,'2026-10-02',{...fri,primary:'e1'},sat);assert.deepEqual(weekendAssignments(next,'2026-10-02'),[{primary:'e1',secondary:'e2'},{primary:'e0',secondary:'e2'}]);assert.equal(blocks('2026-10',[],next.splitWeekends).filter(b=>b.weekendId==='2026-10-02').length,2);assert.equal(s.assignments['2026-10-02'].primary,'e0');});
test('weekend editor swaps half owners without merging the intermediate state, then can reunite them',()=>{let s=demo();s=setWeekendAssignments(s,'2026-07-31',{primary:'e0'},{primary:'e1'});s=setWeekendAssignments(s,'2026-07-31',{primary:'e1'},{primary:'e0'});assert.deepEqual(weekendAssignments(s,'2026-07-31').map(a=>a.primary),['e1','e0']);assert.equal(s.assignments['2026-08-01'].primary,'e0');s=setWeekendAssignments(s,'2026-07-31',{primary:'e1'},{primary:'e1'});assert.equal(s.splitWeekends.length,0);assert.equal(s.assignments['2026-08-01'],undefined);assert.deepEqual(weekendAssignments(s,'2026-07-31').map(a=>a.primary),['e1','e1']);});
test('palette migration preserves version-two assignments, seniority, and publication status',()=>{const s=demo();s.version=2;s.months['2026-10'].status='published';s.assignments['2026-10-02']={primary:'e0'};s.team.reverse();const n=migrate(s);assert.equal(n.version,3);assert.deepEqual(n.assignments,s.assignments);assert.deepEqual(n.months,s.months);assert.deepEqual(n.team.map(p=>p.id),s.team.map(p=>p.id));assert.equal(new Set(n.team.map(p=>p.color)).size,12);assert.deepEqual(n.team.map(p=>p.color),COLORS.slice(0,12));assert.equal(COLORS.length,15);assert.equal(new Set(COLORS).size,15);});
