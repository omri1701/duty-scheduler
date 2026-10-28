import test from 'node:test';
import assert from 'node:assert/strict';
import {blocks, demo} from '../lib/rota/engine.ts';
import {calendarDates, workspaceMetrics, prepareWorkspaceUpdate} from '../lib/rota/workspace-data.ts';

function publishedMonths() {
  const state = demo();
  state.specials = [];
  state.assignments = {};
  state.months = Object.fromEntries(['2026-07', '2026-08', '2026-09'].map(month =>
    [month, {deadline: month + '-01', status: 'published', generated: true}]));
  return state;
}

test('saving another duty preserves the shape, owners and locks of an existing split weekend',()=>{
 const s=publishedMonths();s.months['2026-07'].status='draft';s.splitWeekends=['2026-07-31'];
 s.assignments={'2026-07-31':{primary:'e0',secondary:'e2',locked:true},'2026-08-01':{primary:'e0',secondary:'e2',locked:true},'2026-07-06':{primary:'e1'}};
 const before=structuredClone(s);
 const n=prepareWorkspaceUpdate(s,{...s,assignments:{...s.assignments,'2026-07-06':{primary:'e3'}}},'2026-07',s.months['2026-07']);
 assert.deepEqual(n.splitWeekends,['2026-07-31']);
 for(const day of ['2026-07-31','2026-08-01'])assert.deepEqual(n.assignments[day],before.assignments[day]);
 assert.deepEqual(s,before);
});

test('calendar dates retain complete Sunday–Saturday rows at leap and month boundaries', () => {
  assert.deepEqual([calendarDates('2028-02')[0], calendarDates('2028-02').at(-1)],
    ['2028-01-30', '2028-03-04']);
  assert.equal(calendarDates('2028-02').filter(day => day === '2028-02-29').length, 1);
  assert.equal(calendarDates('2026-11').length, 35);
  assert.equal(calendarDates('2026-02').length, 28);
});

test('coverage and monthly points exclude weekends owned by the previous Friday month', () => {
  const state = publishedMonths();
  state.assignments['2026-07-31'] = {primary: 'e0'};
  const august = workspaceMetrics(state, '2026-08', blocks('2026-08', []));
  assert.equal(august.assigned, 0);
  assert.ok(!august.owned.some(duty => duty.id === '2026-07-31'));
  assert.equal(august.monthTotals.e0, 0);
  assert.equal(august.historyTotals.e0, 1);
});

test('coverage warnings include emergency constraints and respect manager overrides', () => {
  const state = publishedMonths();
  state.assignments = {
    '2026-08-03': {primary: 'e0', secondary: 'e1'},
    '2026-08-04': {primary: 'e0', override: true},
    '2026-08-05': {primary: 'e0'},
  };
  state.constraints = {e0: {'2026-08-04': 'no'}, e1: {'2026-08-03': 'no'}};
  const metrics = workspaceMetrics(state, '2026-08', blocks('2026-08', []));
  assert.equal(metrics.assigned, 3);
  assert.deepEqual(metrics.conflicts.map(duty => duty.id), ['2026-08-03']);
  assert.deepEqual(metrics.gaps.filter(({p}) => p.id === 'e0').map(({b}) => b.id),
    ['2026-08-04', '2026-08-05']);
});

test('editing a boundary weekend reopens only its owning month', () => {
  const state = publishedMonths();
  state.assignments['2026-07-31'] = {primary: 'e0'};
  const before = structuredClone(state);
  const next = prepareWorkspaceUpdate(state, {
    ...state, assignments: {...state.assignments, '2026-07-31': {primary: 'e1'}},
  }, '2026-07', state.months['2026-07']);
  assert.equal(next.months['2026-07'].status, 'draft');
  assert.equal(next.months['2026-08'].status, 'published');
  assert.equal(next.months['2026-09'].status, 'published');
  assert.deepEqual(state, before);
});

test('special-range edits reopen only their owning month', () => {
  const state = publishedMonths();
  const next = prepareWorkspaceUpdate(state, {...state, specials: [
    {id: 'special', title: 'Coverage', start: '2026-08-03', end: '2026-08-04', extra: 1},
  ]}, '2026-08', state.months['2026-08']);
  assert.deepEqual(Object.values(next.months).map(month => month.status), ['published', 'draft', 'published']);
});

test('deadline and publication updates normalize weekends without reopening published months', () => {
  const state = publishedMonths();
  const changed = {...state, months: {...state.months,
    '2026-08': {...state.months['2026-08'], deadline: '2026-07-25'},
  }};
  const next = prepareWorkspaceUpdate(state, changed, '2026-08', state.months['2026-08'], false);
  assert.equal(next.months['2026-08'].deadline, '2026-07-25');
  assert.deepEqual(Object.values(next.months).map(month => month.status),
    ['published', 'published', 'published']);
});

test('editing a different owner fails without mutating either month', () => {
  const state = publishedMonths(), before = structuredClone(state);
  assert.throws(() => prepareWorkspaceUpdate(state, {...state, assignments: {'2026-07-31': {primary:'e1'}}}, '2026-08', state.months['2026-08']), /owning month/);
  assert.deepEqual(state, before);
});
