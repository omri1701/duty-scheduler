import test from 'node:test';
import assert from 'node:assert/strict';
import {publishedSwapDuties,eligibleSwapTarget,visibleSwapRequests,swapStarter,swapWaitingOn,swapNeedsAction,readSwapConflicts,swapSummary} from '../lib/supabase/swaps.ts';
import {todayIsrael} from '../lib/rota/calendar-dates.ts';

test('Israeli midnight expires yesterday, including a continuing Friday weekend',()=>{
 const raw={months:[{month:'2026-10',current_publication_id:'p'}],members:[{id:'a',active:true,status:'approved'}],assignments:[
  {id:'friday',day:'2026-10-16',end_day:'2026-10-18',primary_id:'a',publication_id:'p'},
  {id:'saturday',day:'2026-10-17',end_day:'2026-10-18',primary_id:'a',publication_id:'p'},
  {id:'sunday',day:'2026-10-18',end_day:'2026-10-19',primary_id:'a',publication_id:'p'},
 ]};
 const ids=instant=>publishedSwapDuties(raw,'2026-10',todayIsrael(new Date(instant))).map(d=>d.id);
 assert.deepEqual(ids('2026-10-16T21:00:00Z'),['saturday','sunday']);
 assert.deepEqual(ids('2026-10-17T20:59:59Z'),['saturday','sunday']);
 assert.deepEqual(ids('2026-10-17T21:00:00Z'),['sunday']);
});

test('swap choices use the current publication, active primaries and today or later dates',()=>{
 const raw={months:[{month:'2026-10',status:'draft',current_publication_id:'current'}],members:[{id:'e',active:true,status:'approved'},{id:'off',active:false,status:'approved'}],assignments:[
  {id:'draft',publication_id:null,day:'2026-10-12',primary_id:'e'},
  {id:'old',publication_id:'old',day:'2026-10-12',primary_id:'e'},
  {id:'today',publication_id:'current',day:'2026-10-09',primary_id:'e'},
  {id:'past',publication_id:'current',day:'2026-10-08',primary_id:'e'},
  {id:'off',publication_id:'current',day:'2026-10-12',primary_id:'off'},
  {id:'open',publication_id:'current',day:'2026-10-12',primary_id:null},
  {id:'future',publication_id:'current',day:'2026-10-12',primary_id:'e'},
 ]};
 assert.deepEqual(publishedSwapDuties(raw,'2026-10','2026-10-09').map(d=>d.id),['today','future']);
 assert.deepEqual(publishedSwapDuties(raw,'2026-11','2026-10-09'),[]);
});

test('published drag and keyboard selection require another eligible primary, preserving emergency cover',()=>{
 const own={id:'x',publication_id:'p',primary_id:'a',secondary_id:'cover'};
 const target={id:'y',publication_id:'p',primary_id:'b',secondary_id:null};
 assert.equal(eligibleSwapTarget(own,target),true);
 for(const invalid of [own,{...target,publication_id:'old'},{...target,primary_id:'a'},{...target,primary_id:'cover'},{...target,secondary_id:'a'},undefined]){
  assert.equal(eligibleSwapTarget(own,invalid),false);
 }
});

test('empty request list hides the section; consent and admin action sort before outgoing history',()=>{
 const make=(id,requester_id,other_id,status,created_at='2026-10-09')=>({id,month:'2026-11',requester_id,other_id,status,created_at});
 const requests=[make('old','a','b','approved'),make('out','a','b','awaiting_engineer'),make('incoming','c','a','awaiting_engineer','2026-10-08'),make('admin','b','c','awaiting_admin'),make('private','b','c','declined')];
 assert.deepEqual(visibleSwapRequests(requests,'outsider',false),[]);
 assert.deepEqual(visibleSwapRequests([],'a',true),[]);
 assert.deepEqual(visibleSwapRequests(requests,'a',false).map(r=>r.id),['incoming','old','out']);
 assert.deepEqual(visibleSwapRequests(requests,'a',true).map(r=>r.id),['admin','incoming','old','out']);
 assert.deepEqual(visibleSwapRequests(requests,'b',false).map(r=>r.id),['out','admin','private']);
 assert.deepEqual(visibleSwapRequests(requests.map((r,i)=>({...r,month:i%2?'2026-12':'2026-11'})),'a',true).map(r=>r.id),['admin','incoming','old','out']);
});

test('split Saturday belongs to Friday’s month and carried previous weekends are excluded',()=>{
 const raw={months:[{month:'2026-07',current_publication_id:'july'},{month:'2026-08',current_publication_id:'august'}],members:[{id:'e',active:true,status:'approved'}],assignments:[
  {id:'friday',publication_id:'july',day:'2026-07-31',end_day:'2026-08-01',primary_id:'e'},
  {id:'saturday',publication_id:'july',day:'2026-08-01',end_day:'2026-08-02',primary_id:'e'},
  {id:'copy',publication_id:'august',day:'2026-08-01',end_day:'2026-08-02',primary_id:'e'},
  {id:'combined',publication_id:'august',day:'2026-08-07',end_day:'2026-08-09',primary_id:'e'},
 ]};
 assert.deepEqual(publishedSwapDuties(raw,'2026-07','2026-07-01').map(d=>d.id),['friday','saturday']);
 assert.deepEqual(publishedSwapDuties(raw,'2026-08','2026-07-01').map(d=>d.id),['combined']);
});

test('admin proposals wait on both members, then the admin; the proposer sees and cancels them',()=>{
 const base={id:'p',month:'2026-11',requester_id:'a',other_id:'b',status:'awaiting_engineer',created_at:'2026-10-09',accepted_by:null,requester_accepted_at:null};
 const proposed={...base,proposed_by:'admin'};
 assert.equal(swapStarter(proposed),'admin');
 assert.equal(swapStarter(base),'a');
 assert.deepEqual(swapWaitingOn(proposed),['a','b']);
 assert.deepEqual(swapWaitingOn({...proposed,accepted_by:'b'}),['a']);
 assert.deepEqual(swapWaitingOn({...proposed,requester_accepted_at:'2026-10-09'}),['b']);
 // A requester who asked consented by sending; older rows have no proposal fields.
 assert.deepEqual(swapWaitingOn(base),['b']);
 assert.deepEqual(swapWaitingOn({...proposed,status:'awaiting_admin'}),[]);
 assert.equal(swapNeedsAction(proposed,'a',false),true);
 assert.equal(swapNeedsAction({...proposed,requester_accepted_at:'x'},'a',false),false);
 assert.equal(swapNeedsAction(proposed,'admin',true),false);
 assert.equal(swapNeedsAction({...proposed,status:'awaiting_admin'},'admin',true),true);
 assert.deepEqual(visibleSwapRequests([proposed],'admin',true).map(r=>r.id),['p']);
 assert.deepEqual(visibleSwapRequests([{...proposed,status:'approved'}],'admin',false).map(r=>r.id),['p']);
 assert.deepEqual(visibleSwapRequests([proposed],'c',true),[]);
});

test('availability conflicts carry who and when only; malformed responses fail closed',()=>{
 assert.deepEqual(readSwapConflicts([{member:'b',day:'2026-11-02',note:'ignored'}]),[{member:'b',day:'2026-11-02'}]);
 assert.deepEqual(readSwapConflicts([]),[]);
 assert.deepEqual(readSwapConflicts([{member:null,day:'2026-11-03'}]),[{member:null,day:'2026-11-03'}]);
 for(const bad of [null,{},[{member:'b'}],[{member:1,day:'2026-11-02'}],[{member:'b',day:'2 Nov'}]])assert.throws(()=>readSwapConflicts(bad));
});

test('approval summary names both members, dates and points moved in English and Hebrew',()=>{
 const input={requester:'Alex',other:'Blair',from:{label:'2 Nov 2026',points:1},to:{label:'7 Nov 2026 – 8 Nov 2026',points:1.5}};
 assert.equal(swapSummary({...input,lang:'en'}),[
  'Duty swap: Alex ⇄ Blair',
  'Alex — gives: 2 Nov 2026 (1 pt) · takes: 7 Nov 2026 – 8 Nov 2026 (1.5 pts) · change: +0.5 pts',
  'Blair — gives: 7 Nov 2026 – 8 Nov 2026 (1.5 pts) · takes: 2 Nov 2026 (1 pt) · change: −0.5 pts',
 ].join('\n'));
 const he=swapSummary({...input,lang:'he'}).split('\n');
 assert.equal(he[0],'החלפת תורנויות: Alex ⇄ Blair');
 assert.match(he[1],/מסירה: 2 Nov 2026 \(1 נק׳\) · קבלה: .*\(1.5 נק׳\) · שינוי: \+0.5 נק׳$/);
 assert.match(he[2],/שינוי: −0.5 נק׳$/);
 assert.match(swapSummary({...input,to:{label:'x',points:1},lang:'en'}),/change: 0 pts/);
});
