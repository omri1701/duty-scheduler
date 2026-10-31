import test from 'node:test';
import assert from 'node:assert/strict';
import {weekendRotation} from '../lib/scheduling/rotation.ts';
import {publishedHistory} from '../lib/supabase/snapshot.ts';

const members = ['a', 'b', 'c', 'd'];
const days = (m, test) => Array.from({length: 28}, (_, i) => `${m}-${String(i + 1).padStart(2, '0')}`).filter(d => test(new Date(d + 'T12:00:00Z').getUTCDay()));
/** Weekend owners take that month's Fridays; present members take Sunday–Thursday dates. */
const month = (m, weekendOwners, present = members) => ({month: m, duties: [
  ...weekendOwners.map((id, i) => ({startDate: days(m, dow => dow === 5)[i], primary: id})),
  ...present.map((id, i) => ({startDate: days(m, dow => dow <= 4)[i], primary: id})),
]});

test('weekend turns accumulate until everyone seen in the cycle has one, then the cycle resets', () => {
  assert.deepEqual(weekendRotation([], members, '2026-12'), {a: 0, b: 0, c: 0, d: 0});
  const october = month('2026-10', ['a', 'b']);
  assert.deepEqual(weekendRotation([october], members, '2026-12'), {a: 1, b: 1, c: 0, d: 0});
  const november = month('2026-11', ['c', 'd']);
  assert.deepEqual(weekendRotation([october, november], members, '2026-12'), {a: 0, b: 0, c: 0, d: 0});
  // Order of the input does not matter; the month being generated is excluded.
  assert.deepEqual(weekendRotation([november, october], members, '2026-12'), {a: 0, b: 0, c: 0, d: 0});
  assert.deepEqual(weekendRotation([october, november], members, '2026-11'), {a: 1, b: 1, c: 0, d: 0});
});

test('a skipped member stays due across months; an extra turn carries into the next cycle', () => {
  const history = [month('2026-10', ['a', 'b']), month('2026-11', ['a', 'c'])];
  assert.deepEqual(weekendRotation(history, members, '2026-12'), {a: 2, b: 1, c: 1, d: 0});
  history.push(month('2026-12', ['d']));
  // Everyone has had a turn: counts drop by one; a's second turn is still remembered.
  assert.deepEqual(weekendRotation(history, members, '2027-01'), {a: 1, b: 0, c: 0, d: 0});
});

test('either split half is one turn, both halves are still one turn, and non-members are ignored', () => {
  const split = {month: '2026-11', duties: [{startDate: '2026-11-06', primary: 'a'}, {startDate: '2026-11-07', primary: 'b'},
    {startDate: '2026-11-13', primary: 'c'}, {startDate: '2026-11-14', primary: 'c'}, {startDate: '2026-11-20', primary: 'left'},
    {startDate: '2026-11-21', primary: null}, {startDate: '2026-11-02', primary: 'd'}]};
  assert.deepEqual(weekendRotation([split], members, '2026-12'), {a: 1, b: 1, c: 1, d: 0});
});

test('members with no published duty in the current cycle join the next cycle level with the team', () => {
  const team = [...members, 'e'];
  // In progress (some have had their turn): the newcomer is not due first.
  assert.deepEqual(weekendRotation([month('2026-10', ['a', 'b'])], team, '2026-12'), {a: 1, b: 1, c: 0, d: 0, e: 1});
  // A completed cycle starts everyone, including the newcomer, at zero.
  assert.deepEqual(weekendRotation([month('2026-10', ['a', 'b']), month('2026-11', ['c', 'd'])], team, '2026-12'), {a: 0, b: 0, c: 0, d: 0, e: 0});
  // A member absent from every month of the current cycle is treated like a newcomer, even with history before it.
  const away = [month('2026-09', ['a', 'b']), month('2026-10', ['c', 'd']), month('2026-11', ['a', 'b'], ['a', 'b', 'c'])];
  assert.deepEqual(weekendRotation(away, members, '2026-12'), {a: 1, b: 1, c: 0, d: 1});
});

test('duplicate months or members are rejected', () => {
  assert.throws(() => weekendRotation([month('2026-10', ['a']), month('2026-10', ['b'])], members, '2026-12'), /duplicate-history-month/);
  assert.throws(() => weekendRotation([], ['a', 'a'], '2026-12'), /duplicate-member/);
});

test('published history reads only each month\'s current publication rows owned by that month', () => {
  const row = (day, primary, publication, end_day = day) => ({id: `${publication ?? 'draft'}-${day}`, publication_id: publication, day, end_day, primary_id: primary,
    secondary_id: null, manager_override: false, title: '', extra_points: 0, points: 1});
  const raw = {revision: 1, members: [], roles: [], memberStatuses: [], monthStatuses: [], constraintTypes: [], constraints: [], swapRequests: [],
    months: [{month: '2026-10', deadline: '', status: 'published', generated: true, current_publication_id: 'oct2', publication_sequence: 2},
      {month: '2026-11', deadline: '', status: 'draft', generated: true, current_publication_id: 'nov1', publication_sequence: 1},
      {month: '2026-12', deadline: '', status: 'draft', generated: false, current_publication_id: null, publication_sequence: 0}],
    publications: [{id: 'oct1', month: '2026-10', version: 1, published_at: '', published_by: ''}, {id: 'oct2', month: '2026-10', version: 2, published_at: '', published_by: ''},
      {id: 'nov1', month: '2026-11', version: 1, published_at: '', published_by: ''}],
    assignments: [row('2026-10-30', 'old', 'oct1', '2026-11-01'), row('2026-10-30', 'a', 'oct2', '2026-11-01'), row('2026-10-01', 'b', 'oct2'),
      row('2026-11-06', 'c', 'nov1', '2026-11-08'), row('2026-11-06', 'draft-only', null, '2026-11-08'), row('2026-12-04', 'd', null, '2026-12-06')]};
  assert.deepEqual(publishedHistory(raw), [
    {month: '2026-10', duties: [{startDate: '2026-10-30', primary: 'a'}, {startDate: '2026-10-01', primary: 'b'}]},
    {month: '2026-11', duties: [{startDate: '2026-11-06', primary: 'c'}]},
  ]);
  assert.deepEqual(publishedHistory(raw, '2026-11').map(m => m.month), ['2026-10']);
  assert.deepEqual(weekendRotation(publishedHistory(raw, '2026-12'), ['a', 'b', 'c', 'd'], '2026-12'), {a: 1, b: 0, c: 1, d: 1});
});
