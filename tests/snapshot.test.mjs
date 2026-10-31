import test from 'node:test';
import assert from 'node:assert/strict';
import {fromSnapshot,schedulePayload,canManage,readSnapshot} from '../lib/supabase/snapshot.ts';
import {addDays,blocks,totals} from '../lib/rota/engine.ts';
import {visibleCalendarBlocks} from '../lib/rota/workspace-data.ts';
const member=(id,role='engineer',status='approved')=>({id,email:id+'@example.invalid',name:id,role,status,active:true,seniority:1,color:'#adc9ee'});

test('saved lock flags round-trip without implicitly reviewing unrelated locked duties',()=>{
 const raw=fixture();raw.assignments.find(r=>r.day==='2026-10-01'&&r.publication_id===null).locked=true;
 const state=fromSnapshot(readSnapshot(raw),'admin');assert.equal(state.assignments['2026-10-01'].locked,true);
 const payload=schedulePayload(state,'2026-10');assert.equal(payload.duties.find(d=>d.day==='2026-10-01').locked,true);assert.equal(payload.lock_edits,undefined);
 assert.deepEqual(schedulePayload(state,'2026-10',false,['2026-10-01']).lock_edits,['2026-10-01']);
 raw.assignments[0].locked='true';assert.throws(()=>readSnapshot(raw),/Invalid team data/);
});

test('manager published calendar reads current snapshots across adjacent months, preserving private drafts',()=>{
 const raw=fixture();
 raw.months=[{month:'2027-12',status:'draft',generated:true,current_publication_id:'dec'}, {month:'2028-01',status:'draft',generated:true,current_publication_id:'jan'}];
 raw.publications=[{id:'dec',month:'2027-12'},{id:'jan',month:'2028-01'}];
 raw.assignments=[row('2027-12-31','engineer','dec',{end_day:'2028-01-02'}),row('2028-01-03','engineer','jan'),row('2027-12-31','admin',null,{end_day:'2028-01-02'}),row('2028-01-03','admin',null)];
 const published=fromSnapshot(raw,'admin',undefined,true),draft=fromSnapshot(raw,'admin');
 assert.equal(published.assignments['2027-12-31'].primary,'engineer');
 assert.equal(published.assignments['2028-01-03'].primary,'engineer');
 assert.equal(draft.assignments['2027-12-31'].primary,'admin');
 const visible=visibleCalendarBlocks(published,'2028-01');
 assert.equal(visible.filter(b=>b.id==='2027-12-31').length,1);
 assert.equal(visible.find(b=>b.id==='2027-12-31').end,'2028-01-02');
 raw.months[1].current_publication_id=null;
 assert.equal(fromSnapshot(raw,'admin',undefined,true).assignments['2028-01-03'],undefined);
});
const row=(day,primary='admin',publication=null,options={})=>({id:(publication??'draft')+'-'+day,publication_id:publication,day,end_day:addDays(day,1),primary_id:primary,secondary_id:null,manager_override:false,title:'',extra_points:0,points:1,...options});
function fixture(){return {revision:4,members:[member('admin','admin'),member('engineer'),member('waiting','engineer','pending')],roles:[{code:'admin',label:'Admin',can_manage:true},{code:'engineer',label:'Engineer',can_manage:false}],memberStatuses:[],monthStatuses:[],constraintTypes:[],months:[{month:'2026-10',deadline:'2026-09-24',status:'draft',generated:true,current_publication_id:'v2',publication_sequence:2}],constraints:[{member_id:'engineer',day:'2026-10-01',kind:'no',note:'Vacation'}],assignments:[row('2026-10-01','admin'),row('2026-10-01','admin','v1'),row('2026-10-01','engineer','v2')],publications:[{id:'v1',month:'2026-10',version:1,published_at:'2026-09-20',published_by:'admin'},{id:'v2',month:'2026-10',version:2,published_at:'2026-09-21',published_by:'admin'}]}}
test('admin sees only draft rows and approved engineers',()=>{const state=fromSnapshot(fixture(),'admin');assert.equal(state.assignments['2026-10-01'].primary,'admin');assert.equal(state.months['2026-10'].status,'draft');assert.deepEqual(state.team.map(m=>m.id),['admin','engineer']);assert.equal(state.constraintNotes.engineer['2026-10-01'],'Vacation')});
test('engineer sees current publication while admins edit a draft',()=>{const state=fromSnapshot(fixture(),'engineer');assert.equal(state.assignments['2026-10-01'].primary,'engineer');assert.equal(state.months['2026-10'].status,'published')});
test('unpublished and historical rows never enter the current engineer view',()=>{const raw=fixture();raw.months[0].current_publication_id=null;assert.deepEqual(fromSnapshot(raw,'engineer').assignments,{})});
test('version preview reads precisely the selected version',()=>{const state=fromSnapshot(fixture(),'admin','v1');assert.equal(state.assignments['2026-10-01'].primary,'admin');assert.equal(Object.keys(state.assignments).length,1)});
test('schedule saves omit notes, profile names and membership roles',()=>{const state=fromSnapshot(fixture(),'admin'),payload=schedulePayload(state);assert.equal(payload.constraints,undefined);assert.equal(payload.constraintNotes,undefined);assert.equal(payload.team[0].role,undefined);assert.equal(payload.team[0].name,undefined);assert.equal(payload.team[0].email,undefined)});
test('role capabilities come from the role lookup',()=>{const raw=fixture();raw.members[1].role='admin';assert.equal(canManage(raw,'engineer'),true);raw.roles[0].can_manage=false;assert.equal(canManage(raw,'admin'),false)});
test('combined weekend is a single stored duty row',()=>{const raw=fixture();raw.assignments=[row('2026-10-02','admin',null,{end_day:'2026-10-04'})];const state=fromSnapshot(raw,'admin');assert.equal(blocks('2026-10',state.specials,state.splitWeekends).find(b=>b.start==='2026-10-02').points,1);const payload=schedulePayload(state);assert.equal(payload.duties.find(r=>r.day==='2026-10-02').end_day,'2026-10-04');assert.equal(payload.duties.some(r=>r.day==='2026-10-03'),false)});
test('holiday points survive reassignment and split-weekend round trip',()=>{const raw=fixture();raw.assignments=[row('2026-10-02','admin',null,{title:'Holiday',extra_points:2,points:2.5}),row('2026-10-03','engineer',null,{points:0.5})];const state=fromSnapshot(raw,'admin');state.assignments['2026-10-02'].primary='engineer';const payload=schedulePayload(state);assert.equal(payload.duties.find(r=>r.day==='2026-10-02').extra_points,2);assert.equal(payload.duties.find(r=>r.day==='2026-10-02').primary_id,'engineer');// Each half keeps its own date's extra: the plain Saturday stays plain.
assert.equal(payload.duties.find(r=>r.day==='2026-10-03').extra_points,0);assert.equal(payload.duties.find(r=>r.day==='2026-10-03').title,'');assert.ok(payload.duties.every(r=>r.saturday_extra_points===0));assert.equal(totals(state,blocks('2026-10',state.specials,state.splitWeekends)).engineer,3)});
test('a combined holiday weekend row stores each date\'s extra and round-trips both',()=>{const raw=fixture();const pick=r=>({end_day:r.end_day,title:r.title,extra_points:r.extra_points,saturday_extra_points:r.saturday_extra_points});
 raw.assignments=[row('2026-10-02','admin',null,{title:'Holiday',extra_points:2,saturday_extra_points:2,points:5,end_day:'2026-10-04'})];
 let state=fromSnapshot(readSnapshot(raw),'admin');let b=blocks('2026-10',state.specials,state.splitWeekends).find(b=>b.id==='2026-10-02');
 assert.deepEqual([b.points,b.end,b.specialDates,state.splitWeekends],[5,'2026-10-04',['2026-10-02','2026-10-03'],[]]);
 assert.deepEqual(pick(schedulePayload(state).duties.find(r=>r.day==='2026-10-02')),{end_day:'2026-10-04',title:'Holiday',extra_points:2,saturday_extra_points:2});assert.equal(schedulePayload(state).duties.some(r=>r.day==='2026-10-03'),false);
 // Friday-only holiday: the row stores 2 and 0, reads back as a one-day range and keeps Saturday's plain half point.
 raw.assignments=[row('2026-10-02','admin',null,{title:'Eve',extra_points:2,saturday_extra_points:0,points:3,end_day:'2026-10-04'})];
 state=fromSnapshot(raw,'admin');assert.deepEqual(state.specials.map(s=>[s.start,s.end,s.extra,s.title]),[['2026-10-02','2026-10-03',2,'Eve']]);
 b=blocks('2026-10',state.specials,state.splitWeekends).find(b=>b.id==='2026-10-02');assert.deepEqual([b.points,b.specialDates,b.title],[3,['2026-10-02'],'Eve']);
 assert.deepEqual(pick(schedulePayload(state).duties.find(r=>r.day==='2026-10-02')),{end_day:'2026-10-04',title:'Eve',extra_points:2,saturday_extra_points:0});
 // Saturday-only holiday: 0 and 1.5 become one Saturday range.
 raw.assignments=[row('2026-10-02','admin',null,{title:'Sat',extra_points:0,saturday_extra_points:1.5,points:2.5,end_day:'2026-10-04'})];
 state=fromSnapshot(raw,'admin');assert.deepEqual(state.specials.map(s=>[s.start,s.end,s.extra]),[['2026-10-03','2026-10-04',1.5]]);
 b=blocks('2026-10',state.specials,state.splitWeekends).find(b=>b.id==='2026-10-02');assert.deepEqual([b.points,b.specialDates],[2.5,['2026-10-03']]);
 assert.deepEqual(pick(schedulePayload(state).duties.find(r=>r.day==='2026-10-02')),{end_day:'2026-10-04',title:'Sat',extra_points:0,saturday_extra_points:1.5});
 // Rows saved before the column existed read as plain combined weekends; a non-numeric value is refused.
 raw.assignments=[row('2026-10-02','admin',null,{points:1,end_day:'2026-10-04'})];delete raw.assignments[0].saturday_extra_points;
 assert.equal(blocks('2026-10',fromSnapshot(readSnapshot(raw),'admin').specials).find(b=>b.id==='2026-10-02').points,1);
 raw.assignments[0].saturday_extra_points='2';assert.throws(()=>readSnapshot(raw),/Invalid team data/)});
test('new workspace stays empty until generation is requested',()=>{const raw=fixture();raw.assignments=[];raw.publications=[];raw.months=[];const state=fromSnapshot(raw,'admin');assert.deepEqual(state.assignments,{});assert.deepEqual(schedulePayload(state).duties,[])});
test('published manager view uses the publication without duplicate working rows',()=>{
 const raw=fixture();raw.months[0].status='published';raw.assignments=raw.assignments.filter(r=>r.publication_id!==null);
 const state=fromSnapshot(raw,'admin');assert.equal(state.assignments['2026-10-01'].primary,'engineer');
 assert.equal(state.months['2026-10'].status,'published');
 assert.deepEqual(schedulePayload(state).duties,[]);
 assert.deepEqual(schedulePayload(state,'2026-10').duties,[],'Settings saves must not recreate assignments');
});
test('scoped draft save excludes other months and carried weekends',()=>{
 const state=fromSnapshot(fixture(),'admin');state.months['2026-11']={deadline:'2026-10-24',status:'draft',generated:true};
 state.assignments['2026-11-02']={primary:'engineer'};
 const payload=schedulePayload(state,'2026-11');
 assert.deepEqual(Object.keys(payload.months),['2026-11']);
 assert(payload.duties.every(r=>r.day>='2026-11-01'));
 assert.equal(schedulePayload(state,'2026-10').duties.some(r=>r.day==='2026-11-02'),false);
});
test('reopened draft and adjacent published month use separate schedule sources',()=>{
 const raw=fixture();raw.months.push({month:'2026-11',status:'published',generated:true,current_publication_id:'nov'});
 raw.publications.push({id:'nov',month:'2026-11'});raw.assignments.push(row('2026-11-02','engineer','nov'));
 const state=fromSnapshot(raw,'admin');assert.equal(state.assignments['2026-10-01'].primary,'admin');
 assert.equal(state.assignments['2026-11-02'].primary,'engineer');
 assert.equal(schedulePayload(state).duties.some(r=>r.day==='2026-11-02'),false);
});
test('Friday owner publication wins across a month boundary',()=>{const raw=fixture();raw.months=[{month:'2026-07',deadline:'2026-06-24',status:'published',current_publication_id:'july'},{month:'2026-08',deadline:'2026-07-24',status:'published',current_publication_id:'august'}];raw.publications=[{id:'july',month:'2026-07'},{id:'august',month:'2026-08'}];raw.assignments=[row('2026-07-31','admin','august',{end_day:'2026-08-02'}),row('2026-07-31','engineer','july'),row('2026-08-01','admin','july')];const state=fromSnapshot(raw,'engineer');assert.equal(state.assignments['2026-07-31'].primary,'engineer');assert.equal(state.assignments['2026-08-01'].primary,'admin');assert.deepEqual(state.splitWeekends,['2026-07-31'])});

test('snapshot validation accepts nullable revisions, optional swaps and extra database columns',()=>{
 const raw=fixture();raw.revision=null;raw.members[0].joined_at='2026-10-01';
 assert.equal(readSnapshot(raw),raw);
 raw.swapRequests=[];assert.equal(readSnapshot(raw),raw);
});
test('temporary members keep identity, constraints and history through snapshot conversion and schedule payloads',()=>{
 const raw=fixture(),temporary={...member('temporary'),email:null,is_temporary:true};
 raw.members.push(temporary);raw.constraints.push({member_id:temporary.id,day:'2026-10-02',kind:'no',note:'Private absence'});
 raw.assignments.push(row('2026-10-02',temporary.id));
 assert.equal(readSnapshot(raw),raw);
 let state=fromSnapshot(raw,'admin');
 assert.equal(state.team.find(m=>m.id===temporary.id).active,true);
 assert.equal(state.constraints[temporary.id]['2026-10-02'],'no');
 temporary.active=false;state=fromSnapshot(raw,'admin');
 assert.equal(state.assignments['2026-10-02'].primary,temporary.id);
 assert.equal(schedulePayload(state).team.find(m=>m.id===temporary.id).active,false);
 raw.members.at(-1).is_temporary='yes';assert.throws(()=>readSnapshot(raw),/Invalid team data/);
});
test('snapshot validation rejects malformed nested data and unsafe revisions',()=>{
 for(const value of [null,[],{...fixture(),members:null},{...fixture(),roles:[{code:'admin',label:'Admin',can_manage:'true'}]},{...fixture(),constraints:[{member_id:'engineer',day:'2026-10-01',kind:'no',note:42}]},{...fixture(),revision:NaN},{...fixture(),revision:Number.MAX_SAFE_INTEGER+1},{...fixture(),swapRequests:[{status:'unexpected'}]}])assert.throws(()=>readSnapshot(value),/Invalid team data/);
});
test('snapshot conversion and payload generation preserve frozen inputs and isolate returned state',()=>{
 function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value)}return value}
 const raw=freeze(fixture()),before=structuredClone(raw);
 const state=fromSnapshot(readSnapshot(raw),'admin');
 state.team[0].name='Local draft';state.constraintNotes.engineer['2026-10-01']='Local note';
 freeze(state);schedulePayload(state);
 assert.deepEqual(raw,before);
});
