import test from 'node:test';
import assert from 'node:assert/strict';
import {blocks} from '../lib/rota/engine.ts';
import {extraPoints, streakCells} from '../lib/rota/streaks.ts';

// October 2026 starts on a Thursday: Thu 1, weekend 2–3, Sun 4 … Thu 29, weekend 30–31, Sun 1 November.
const visible = specials => [...new Map([...blocks('2026-10', specials), ...blocks('2026-11', [])].map(b => [b.id, b])).values()];
const own = primary => ({primary});

test('adjacent duties of one member form one streak: name first, title once, total badge last, row break marked', () => {
  const specials = [{id: 'h', title: 'Holiday', start: '2026-10-04', end: '2026-10-06', extra: 2}];
  const cells = streakCells(visible(specials), {'2026-10-01': own('a'), '2026-10-02': own('a'), '2026-10-04': own('a'), '2026-10-05': own('a'),
    '2026-10-06': own('b'), '2026-10-07': own('b'), '2026-10-09': own('c'), '2026-10-29': own('d'), '2026-10-30': own('d'), '2026-11-01': own('d')});
  // Thu 1 → combined weekend 2–3 (ends on Saturday: row break) → holiday Sun 4 → holiday Mon 5.
  assert.deepEqual(cells['2026-10-01'], {position: 'start', breakBefore: false, breakAfter: false, showName: true, showTitle: false});
  assert.deepEqual(cells['2026-10-02'], {position: 'middle', breakBefore: false, breakAfter: true, showName: false, showTitle: false});
  assert.deepEqual(cells['2026-10-04'], {position: 'middle', breakBefore: true, breakAfter: false, showName: true, showTitle: true});
  assert.deepEqual(cells['2026-10-05'], {position: 'end', breakBefore: false, breakAfter: false, showName: false, showTitle: false, badge: 4});
  // Two plain weekdays: a bar without a badge. A lone duty stands alone.
  assert.deepEqual([cells['2026-10-06'].position, cells['2026-10-07'].position, 'badge' in cells['2026-10-07']], ['start', 'end', false]);
  assert.deepEqual(cells['2026-10-09'], {position: 'only', breakBefore: false, breakAfter: false, showName: true, showTitle: false});
  // Unassigned dates never join: Thu 8 has no primary, so Fri 9 is not continued from it.
  assert.equal(cells['2026-10-08'].position, 'only');
  // Month edge: Thu 29 → weekend 30–31 (row break) → Sunday 1 November, an adjacent duty of the next month.
  assert.deepEqual([cells['2026-10-29'].position, cells['2026-10-30'].breakAfter, cells['2026-11-01'].position, cells['2026-11-01'].breakBefore, cells['2026-11-01'].showName],
    ['start', true, 'end', true, true]);
  assert.equal(Object.keys(cells).length, visible(specials).length, 'every visible duty gets a cell');
});

test('a hand-split weekend and a lone special duty keep per-date badges; different members never join', () => {
  const specials = [{id: 'h', title: 'Holiday', start: '2026-10-02', end: '2026-10-04', extra: 1}];
  const duties = visible(specials).filter(b => b.start.startsWith('2026-10'));
  const combined = streakCells(duties, {'2026-10-02': own('a'), '2026-10-04': own('b')});
  assert.deepEqual(combined['2026-10-02'], {position: 'only', breakBefore: false, breakAfter: false, showName: true, showTitle: true, badge: 2});
  const split = streakCells([...new Map([...blocks('2026-10', specials, ['2026-10-02'])].map(b => [b.id, b])).values()], {'2026-10-02': own('a'), '2026-10-03': own('a')});
  assert.deepEqual([split['2026-10-02'].position, split['2026-10-02'].showTitle, split['2026-10-03'].position, split['2026-10-03'].badge], ['start', true, 'end', 2]);
  assert.equal(split['2026-10-02'].breakAfter, false, 'Friday → Saturday is inside one row');
  assert.equal('badge' in split['2026-10-02'], false, 'the total shows once, on the last day');
});

test('extraPoints is the weight beyond the ordinary points of a day, a combined weekend or a half', () => {
  const specials = [{id: 'h', title: 'Holiday', start: '2026-10-01', end: '2026-10-03', extra: 1.5}];
  const combined = blocks('2026-10', specials), split = blocks('2026-10', specials, ['2026-10-02']);
  assert.equal(extraPoints(combined.find(b => b.id === '2026-10-01')), 1.5);
  assert.equal(extraPoints(combined.find(b => b.id === '2026-10-02')), 1.5, 'Friday-only holiday weekend');
  assert.equal(extraPoints(split.find(b => b.id === '2026-10-02')), 1.5);
  assert.equal(extraPoints(split.find(b => b.id === '2026-10-03')), 0);
  assert.equal(extraPoints(combined.find(b => b.id === '2026-10-09')), 0);
});
