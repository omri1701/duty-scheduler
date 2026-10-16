import test from 'node:test';
import assert from 'node:assert/strict';
import {calendarDates,calendarCells,publicCalendarCells,dayOf,addDays} from '../lib/rota/calendar-dates.ts';
import {blocks} from '../lib/rota/engine.ts';

test('public calendar uses the real ordinary date grid for every month across boundaries',()=>{
  for(let year=2024;year<=2028;year++)for(let m=1;m<=12;m++){
    const month=`${year}-${String(m).padStart(2,'0')}`,days=calendarDates(month);
    assert.equal(days.length%7,0);
    assert.equal(dayOf(days[0]),0);assert.equal(dayOf(days.at(-1)),6);
    const actual=calendarCells(days,blocks(month,[])),publicCells=publicCalendarCells(month);
    assert.deepEqual(publicCells.map(c=>[c.date,c.combined]),actual.map(c=>[c.date,c.combined]),month);
    for(const cell of publicCells.filter(c=>c.combined)){
      assert.equal(dayOf(cell.date),5);
      assert(!publicCells.some(other=>other.date===addDays(cell.date,1)));
    }
  }
  assert.equal(calendarDates('2026-02').length,28);
  assert.equal(calendarDates('2026-11').length,35);
  assert.equal(calendarDates('2026-08').length,42);
});

test('verified private splits/specials still control the real calendar, never the public shell',()=>{
  const month='2026-08',days=calendarDates(month),plain=publicCalendarCells(month);
  const privateBlocks=blocks(month,[{id:'private',title:'Private holiday',start:'2026-08-14',end:'2026-08-15',extra:2}],['2026-08-07']);
  const actual=calendarCells(days,privateBlocks);
  assert(actual.some(c=>c.date==='2026-08-08'));
  assert(actual.some(c=>c.date==='2026-08-15'));
  assert(!plain.some(c=>c.date==='2026-08-08'));
  assert(!plain.some(c=>c.date==='2026-08-15'));
  assert.equal(actual.find(c=>c.date==='2026-07-31').combined,true);
});
