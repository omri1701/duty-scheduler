import test from 'node:test';
import assert from 'node:assert/strict';
import {publishedSwapDuties} from '../lib/supabase/swaps.ts';

test('swap choices use the current publication, active primaries and strictly future dates',()=>{
 const raw={months:[{month:'2026-10',status:'draft',current_publication_id:'current'}],members:[{id:'e',active:true,status:'approved'},{id:'off',active:false,status:'approved'}],assignments:[
  {id:'draft',publication_id:null,day:'2026-10-12',primary_id:'e'},
  {id:'old',publication_id:'old',day:'2026-10-12',primary_id:'e'},
  {id:'today',publication_id:'current',day:'2026-10-09',primary_id:'e'},
  {id:'past',publication_id:'current',day:'2026-10-08',primary_id:'e'},
  {id:'off',publication_id:'current',day:'2026-10-12',primary_id:'off'},
  {id:'open',publication_id:'current',day:'2026-10-12',primary_id:null},
  {id:'future',publication_id:'current',day:'2026-10-12',primary_id:'e'},
 ]};
 assert.deepEqual(publishedSwapDuties(raw,'2026-10','2026-10-09').map(d=>d.id),['future']);
 assert.deepEqual(publishedSwapDuties(raw,'2026-11','2026-10-09'),[]);
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
