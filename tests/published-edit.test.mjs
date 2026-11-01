import test from 'node:test';
import assert from 'node:assert/strict';
import {dutyPoints,editConflicts,editStale,editSummary,editablePublishedDuty,owedUnits,pendingSwaps,validExtra} from '../lib/supabase/published-edit.ts';

const row=(day,end_day,extra_points=0,saturday_extra_points=0,primary_id='a')=>({id:day,publication_id:'p',day,end_day,primary_id,secondary_id:null,manager_override:false,title:'',extra_points,saturday_extra_points,points:0});
const names={a:'Alex Atlas',b:'Blair Birch'},name=id=>names[id];

test('points mirror the stored column and the debt is each date’s shared half points',()=>{
 const tuesday=row('2026-11-03','2026-11-04'),weekend=row('2026-11-06','2026-11-08');
 assert.equal(dutyPoints(tuesday,0),1);assert.equal(dutyPoints(tuesday,1.5),2.5);
 assert.equal(dutyPoints(row('2026-11-07','2026-11-08'),0),.5);
 assert.equal(dutyPoints(weekend,.5,1),2.5);
 assert.equal(owedUnits(tuesday,0),2);
 // Added extra counts for whoever does the duty; the debt keeps the published points.
 assert.equal(owedUnits(tuesday,1.5),2);
 assert.equal(owedUnits(row('2026-11-03','2026-11-04',1.5),1.5),5);
 assert.equal(owedUnits(row('2026-11-03','2026-11-04',2),.5),3);
 assert.equal(owedUnits(weekend,.5,0),2);
 assert.equal(owedUnits(row('2026-11-06','2026-11-08',1,.5),0,.5),3);
 assert.equal(owedUnits(row('2026-11-07','2026-11-08'),0),1);
});

test('extra points are half points from 0 to 20',()=>{
 for(const v of [0,.5,1,19.5,20])assert.equal(validExtra(v),true);
 for(const v of [-.5,.25,20.5,Number.NaN,Infinity])assert.equal(validExtra(v),false);
});

test('only the month’s current publication, today or later, with a primary is editable',()=>{
 const raw={months:[{month:'2026-11',current_publication_id:'p'}],constraints:[],assignments:[
  row('2026-11-02','2026-11-03'),{...row('2026-11-03','2026-11-04'),publication_id:'old'},row('2026-11-04','2026-11-05',0,0,null),
  row('2026-11-30','2026-12-01'),{...row('2026-12-04','2026-12-06')},{...row('2026-10-31','2026-11-01')}]};
 assert.equal(editablePublishedDuty(raw,'2026-11','2026-11-02','2026-11-02')?.day,'2026-11-02');
 assert.equal(editablePublishedDuty(raw,'2026-11','2026-11-03','2026-11-02'),undefined);
 assert.equal(editablePublishedDuty(raw,'2026-11','2026-11-01','2026-11-03'),undefined);
 assert.equal(editablePublishedDuty(raw,'2026-11','2026-11-01','2026-11-04'),undefined);
 assert.equal(editablePublishedDuty(raw,'2026-11','2026-11-01','2026-12-04'),undefined);
 assert.equal(editablePublishedDuty(raw,'2026-11','2026-10-01','2026-10-31'),undefined);
});

test('an opened duty is stale once a newer version is published or a draft is reopened',()=>{
 const tuesday=row('2026-11-03','2026-11-04'),month=(status,current_publication_id)=>({months:[{month:'2026-11',status,current_publication_id}]});
 assert.equal(editStale(month('published','p'),tuesday),false);
 assert.equal(editStale(month('published','newer'),tuesday),true);
 assert.equal(editStale(month('draft','p'),tuesday),true);
 // A Saturday belongs to the month of its Friday.
 assert.equal(editStale(month('published','p'),row('2026-11-07','2026-11-08')),false);
 assert.equal(editStale({months:[]},tuesday),true);
});

test('pending swap requests that include the duty are named; resolved ones are not',()=>{
 const request=(status,from_day,to_day)=>({status,from_day,to_day});
 const raw={swapRequests:[request('awaiting_admin','2026-11-03','2026-11-05'),request('awaiting_engineer','2026-11-02','2026-11-03'),
  request('approved','2026-11-03','2026-11-09'),request('invalidated','2026-11-03','2026-11-10'),request('awaiting_admin','2026-11-04','2026-11-05')]};
 assert.equal(pendingSwaps(raw,row('2026-11-03','2026-11-04')).length,2);
 assert.equal(pendingSwaps({},row('2026-11-03','2026-11-04')).length,0);
});

test('availability conflicts name each unavailable date of the duty',()=>{
 const raw={constraints:[{member_id:'b',day:'2026-11-07',kind:'no',note:'Wedding'},{member_id:'b',day:'2026-11-06',kind:'prefer',note:''},
  {member_id:'b',day:'2026-11-08',kind:'no',note:''},{member_id:'a',day:'2026-11-06',kind:'no',note:''}]};
 assert.deepEqual(editConflicts(raw,'b',row('2026-11-06','2026-11-08')),[{day:'2026-11-07',note:'Wedding'}]);
});

test('the summary states dates, engineers, points, kind and who owes whom, in English and Hebrew',()=>{
 const tuesday=row('2026-11-03','2026-11-04');
 assert.equal(editSummary(tuesday,{primary:'b',extra:.5,saturdayExtra:0,kind:'temporary',overrideReason:''},name,'en'),
  'Duty change (published schedule)\nDate: Tue 03/11/2026\nEngineer: Alex Atlas → Blair Birch\nPoints: 1 point → 1.5 points\nExtra: none → 0.5 points\nType: Temporary\nBalance: Alex Atlas owes Blair Birch 1 point');
 const weekend=editSummary(row('2026-11-06','2026-11-08'),{primary:'b',extra:0,saturdayExtra:0,kind:'permanent',overrideReason:' Clinic '},name,'en');
 assert.match(weekend,/^Date: Fri 06\/11\/2026 – Sat 07\/11\/2026$/m);
 assert.match(weekend,/^Points: 1 point$/m);assert.match(weekend,/^Extra: none$/m);
 assert.match(weekend,/^Type: Permanent\nBalance: No debt\nAvailability override: Clinic$/m);
 assert.match(editSummary(tuesday,{primary:'a',extra:1,saturdayExtra:0,kind:'temporary',overrideReason:'ignored'},name,'en'),
  /Engineer: Alex Atlas \(unchanged\)\nPoints: 1 point → 2 points\nExtra: none → 1 point\nBalance: No debt; the extra counts for Alex Atlas$/);
 const hebrew=editSummary(row('2026-11-03','2026-11-04',.5),{primary:'b',extra:.5,saturdayExtra:0,kind:'temporary',overrideReason:''},name,'he');
 assert.match(hebrew,/^שינוי תורנות \(לוח שפורסם\)\nתאריך: יום ג׳ 03\/11\/2026$/m);
 assert.match(hebrew,/^מהנדס: Blair Birch במקום Alex Atlas$/m);
 assert.match(hebrew,/^נקודות: 1.5 נקודות$/m);assert.match(hebrew,/^תוספת: 0.5 נקודות$/m);
 assert.doesNotMatch(hebrew,/[←→]/);
 assert.match(hebrew,/^סוג: זמני$/m);
 assert.match(hebrew,/^מאזן: Alex Atlas חייב\/ת ל־Blair Birch 1.5 נקודות$/m);
 assert.doesNotMatch(hebrew,/Temporary|Balance/);
});
