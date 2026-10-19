import test from 'node:test';
import assert from 'node:assert/strict';
import {calendarDates,calendarCells,publicCalendarCells,dayOf,addDays,calendarOwnerMonth} from '../lib/rota/calendar-dates.ts';
import {blocks,ownerMonth,dates} from '../lib/rota/engine.ts';
import {visibleCalendarBlocks} from '../lib/rota/workspace-data.ts';

test('public calendar uses the real ordinary date grid for every month across boundaries',()=>{
  for(let year=2024;year<=2028;year++)for(let m=1;m<=12;m++){
    const month=`${year}-${String(m).padStart(2,'0')}`,days=calendarDates(month);
    assert.equal(days.length%7,0);
    assert.equal(dayOf(days[0]),0);assert.equal(dayOf(days.at(-1)),6);
    const actual=calendarCells(days,visibleCalendarBlocks({specials:[],splitWeekends:[]},month)),publicCells=publicCalendarCells(month);
    assert.deepEqual(publicCells.map(c=>[c.date,c.combined]),actual.map(c=>[c.date,c.combined]),month);
    for(const cell of publicCells.filter(c=>c.combined)){
      assert.equal(dayOf(cell.date),5);
      assert(!publicCells.some(other=>other.date===addDays(cell.date,1)));
    }
  }
  assert.equal(calendarDates('2026-02').length,28);
  assert.equal(calendarDates('2026-11').length,35);
  assert.equal(calendarDates('2026-08').length,35);
});

test('verified private splits/specials still control the real calendar, never the public shell',()=>{
  const month='2026-08',days=calendarDates(month),plain=publicCalendarCells(month);
  const privateBlocks=blocks(month,[{id:'private',title:'Private holiday',start:'2026-08-14',end:'2026-08-15',extra:2}],['2026-08-07']);
  const actual=calendarCells(days,privateBlocks);
  assert(actual.some(c=>c.date==='2026-08-08'));
  assert(actual.some(c=>c.date==='2026-08-15'));
  assert(!plain.some(c=>c.date==='2026-08-08'));
  assert(!plain.some(c=>c.date==='2026-08-15'));
  assert(!actual.some(c=>c.date==='2026-07-31'));
});

test('Saturday-start months omit the whole first row; Friday keeps the cross-year Saturday',()=>{
  assert.equal(calendarDates('2028-01')[0],'2028-01-02');
  assert.equal(calendarDates('2027-12').at(-1),'2028-01-01');
  assert.equal(calendarOwnerMonth('2028-01-01'),'2027-12');
  for(const split of [[],['2027-12-31']])for(const month of ['2027-12','2028-01']){
    for(const block of blocks(month,[],split))for(const date of dates(block.start,block.end)){
      assert.equal(calendarOwnerMonth(date),ownerMonth(block));
      if(ownerMonth(block)===month)assert(calendarDates(month).includes(date),date);
    }
  }
  for(let year=2024;year<=2028;year++)for(let m=1;m<=12;m++){
    const month=`${year}-${String(m).padStart(2,'0')}`,first=month+'-01';
    if(dayOf(first)===6) assert.equal(calendarDates(month)[0],addDays(first,1));
  }
});
