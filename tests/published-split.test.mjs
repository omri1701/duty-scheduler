import test from 'node:test';
import assert from 'node:assert/strict';
import {halfPoints,joinedCover,publishedWeekend,weekendChanges,weekendConflicts,weekendEditSummary} from '../lib/supabase/published-edit.ts';
import {swapProblem} from '../lib/supabase/swaps.ts';
import {fromSnapshot} from '../lib/supabase/snapshot.ts';
import {weekendCounts} from '../lib/rota/engine.ts';

// Split a published weekend (decision 2026-11-07). Yossi (y) has 6–8 Nov 2026; Noa (n), Dan (d).
const row=(day,end_day,primary_id,extra_points=0,saturday_extra_points=0,publication_id='p')=>({id:`${publication_id}-${day}`,publication_id,day,end_day,primary_id,secondary_id:null,manager_override:false,title:'',extra_points,saturday_extra_points,points:0});
const names={y:'Yossi',n:'Noa',d:'Dan'},name=id=>names[id];
const raw=(assignments,constraints=[])=>({months:[{month:'2026-11',status:'published',current_publication_id:'p',deadline:'2026-10-24',generated:true,publication_sequence:1}],
 members:Object.keys(names).map(id=>({id,name:names[id],status:'approved',active:true,role:'engineer',color:'#adc9ee'})),roles:[],constraints,assignments,publications:[],swapRequests:[]});
const joined=raw([row('2026-11-06','2026-11-08','y',0,.5),row('2026-11-03','2026-11-04','n')]);
const edit=(fri,sat,kind='temporary',fridayExtra=0,saturdayExtra=.5)=>({fridayPrimary:fri,fridayExtra,saturdayPrimary:sat,saturdayExtra,kind,overrideReason:''});
// Each change moves `owed` points from the giver's net to the taker's (Temporary only).
const nets=(changes)=>changes.reduce((n,c)=>({...n,[c.from]:(n[c.from]??0)-c.owed,[c.to]:(n[c.to]??0)+c.owed}),{});

test('a published weekend is read as its two dates, each with its own points, until Friday starts',()=>{
 const w=publishedWeekend(joined,joined.assignments[0],'2026-11-06');
 assert.deepEqual([w.friday,w.joined,w.fri.primary,w.fri.extra,w.sat.day,w.sat.primary,w.sat.extra],['2026-11-06',true,'y',0,'2026-11-07','y',.5]);
 // Each half starts at its date's own points: half the weekend's when the extras are equal.
 assert.deepEqual([halfPoints(w.fri.extra),halfPoints(w.sat.extra)],[.5,1]);
 // A Saturday half opens the same weekend; a started weekend or a weekday is not one.
 const split=raw([row('2026-11-06','2026-11-07','y'),row('2026-11-07','2026-11-08','n',1)]);
 const s=publishedWeekend(split,split.assignments[1],'2026-11-05');
 assert.deepEqual([s.joined,s.fri.primary,s.sat.primary,s.sat.extra],[false,'y','n',1]);
 assert.equal(publishedWeekend(split,split.assignments[1],'2026-11-07'),null);
 assert.equal(publishedWeekend(joined,joined.assignments[1],'2026-11-01'),null);
});

test('split Temporary: the holder owes the taker that half’s points; Permanent says no debt',()=>{
 const w=publishedWeekend(joined,joined.assignments[0],'2026-11-01');
 const changes=weekendChanges(w,edit('y','n'));
 assert.deepEqual(changes,[{day:'2026-11-07',from:'y',to:'n',owed:1}]);
 assert.deepEqual(nets(changes),{y:-1,n:1});
 const temporary=weekendEditSummary(w,edit('y','n'),name,'en');
 assert.equal(temporary,'Duty change (published schedule)\nDate: Fri 06/11/2026 – Sat 07/11/2026\nWeekend: One weekend → Two days\nFri 06/11/2026: Yossi (unchanged) · 0.5 points\nSat 07/11/2026: Yossi → Noa · 1 point\nType: Temporary\nBalance Sat 07/11/2026: Yossi owes Noa 1 point');
 const permanent=weekendEditSummary(w,edit('y','n','permanent'),name,'en');
 assert.match(permanent,/Type: Permanent\nBalance Sat 07\/11\/2026: No debt$/);
 // H1: giving a day back to who held it before a Temporary change cancels that debt.
 assert.match(weekendEditSummary(w,edit('y','n','permanent'),name,'en',new Set(['2026-11-07'])),/Noa gets the day back/);
 // Hebrew joins values with words, never arrows between Latin names.
 const he=weekendEditSummary(w,edit('y','n'),name,'he');
 assert.match(he,/Noa במקום Yossi/);assert.doesNotMatch(he,/→/);
});

test('per-day points are kept as typed; added points count for whoever does the day',()=>{
 const w=publishedWeekend(joined,joined.assignments[0],'2026-11-01');
 // Saturday raised to 2 points for Noa: Yossi owes only Saturday's published 1 point.
 assert.deepEqual(weekendChanges(w,edit('y','n','temporary',0,1.5)),[{day:'2026-11-07',from:'y',to:'n',owed:1}]);
 assert.match(weekendEditSummary(w,edit('y','n','temporary',0,1.5),name,'en'),/Sat 07\/11\/2026: Yossi → Noa · 1 point → 2 points/);
 // Points alone: no change of person, no debt.
 assert.deepEqual(weekendChanges(w,edit('y','y','temporary',.5,.5)),[]);
 assert.match(weekendEditSummary(w,edit('y','y','temporary',.5,.5),name,'en'),/Weekend: One weekend\n.*0\.5 points → 1 point/s);
});

test('joining back reverses the half’s debt exactly; changing a half chains; nets add up',()=>{
 const split=raw([row('2026-11-06','2026-11-07','y'),row('2026-11-07','2026-11-08','n',.5)]);
 const w=publishedWeekend(split,split.assignments[0],'2026-11-01');
 const first=weekendChanges(publishedWeekend(joined,joined.assignments[0],'2026-11-01'),edit('y','n'));
 const back=weekendChanges(w,edit('y','y'));
 assert.deepEqual(back,[{day:'2026-11-07',from:'n',to:'y',owed:1}]);
 assert.match(weekendEditSummary(w,edit('y','y'),name,'en'),/Weekend: Two days → One weekend/);
 const total=nets([...first,...back]);
 assert.deepEqual(total,{y:0,n:0});
 // Noa's Saturday to Dan: Yossi owes Noa, Noa owes Dan, so Noa is square.
 const chained=nets([...first,...weekendChanges(w,edit('y','d'))]);
 assert.deepEqual(chained,{y:-1,n:0,d:1});
 for(const n of [total,chained])assert.equal(Object.values(n).reduce((a,b)=>a+b,0),0);
 // A swap of both days to different people moves each date on its own.
 assert.deepEqual(weekendChanges(w,edit('n','y')).map(c=>[c.day,c.from,c.to]),[['2026-11-06','y','n'],['2026-11-07','n','y']]);
});

test('availability conflicts are the dates a member newly takes, never notes of others',()=>{
 const r=raw(joined.assignments,[{member_id:'n',day:'2026-11-07',kind:'no',note:'clinic'},{member_id:'n',day:'2026-11-06',kind:'no',note:'x'},{member_id:'d',day:'2026-11-07',kind:'no',note:'y'}]);
 const w=publishedWeekend(r,r.assignments[0],'2026-11-01');
 assert.deepEqual(weekendConflicts(r,w,edit('y','n')),[{day:'2026-11-07',member:'n',note:'clinic'}]);
 assert.deepEqual(weekendConflicts(r,w,edit('y','y','temporary',1,1)),[]);
 // Joining moves Friday's cover (Dan) onto Saturday, which Dan can't do.
 const covered=raw([{...row('2026-11-06','2026-11-07','y'),secondary_id:'d'},{...row('2026-11-07','2026-11-08','n'),secondary_id:'y'}],[{member_id:'d',day:'2026-11-07',kind:'no',note:'y'}]);
 const c=publishedWeekend(covered,covered.assignments[0],'2026-11-01');
 assert.equal(joinedCover(c,edit('y','y')),'d');
 assert.deepEqual(weekendConflicts(covered,c,edit('y','y')),[{day:'2026-11-07',member:'d',note:'y'}]);
 // Keeping Noa keeps Saturday's cover, Yossi: no conflict.
 assert.equal(joinedCover(c,edit('n','n')),'y');
 assert.deepEqual(weekendConflicts(covered,c,edit('n','n')),[]);
});

test('each half is a normal day: weekend rules count a split weekend once and swaps of a half pass',()=>{
 const r=raw([row('2026-11-06','2026-11-07','y'),row('2026-11-07','2026-11-08','n'),row('2026-11-13','2026-11-15','n'),row('2026-11-03','2026-11-04','y')]);
 const state=fromSnapshot(r,'y',undefined,true);
 assert.deepEqual(state.splitWeekends,['2026-11-06']);
 // Yossi holds Friday only; Noa holds Saturday and the 13th: one and two weekends.
 assert.deepEqual([weekendCounts(state,'2026-11').y,weekendCounts(state,'2026-11').n],[1,2]);
 // Noa gives her Saturday to Yossi for his Tuesday: still one weekend for Yossi.
 assert.equal(swapProblem(r,'2026-11',r.assignments[1],r.assignments[3]),null);
 // Yossi's Friday for Noa's weekend of the 13th: each still has one weekend (Noa's halves count once).
 assert.deepEqual(swapProblem(r,'2026-11',r.assignments[0],r.assignments[2]),null);
 // With a second weekend of his own, taking hers would give Yossi another.
 const two=raw([...r.assignments,row('2026-11-20','2026-11-22','y')]);
 assert.deepEqual(swapProblem(two,'2026-11',two.assignments[3],two.assignments[2]),{kind:'weekend',person:'y'});
});
