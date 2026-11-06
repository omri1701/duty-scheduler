import test from 'node:test';
import assert from 'node:assert/strict';
import {HOURS, QUARTERS, WHEEL_ROW, centredIndex, joinTime, keyedIndex, splitTime} from '../lib/push/time-wheel.ts';

test('the wheels hold every hour and the quarter hours the 15-minute clock keeps', () => {
  assert.deepEqual(HOURS, Array.from({length: 24}, (_, h) => h));
  assert.deepEqual(QUARTERS, [0, 15, 30, 45]);
  assert.equal(WHEEL_ROW, 44);
});

test('times map to wheel values and back; off-step minutes move down to their quarter hour', () => {
  assert.deepEqual(splitTime('18:00'), {hour: 18, minute: 0});
  assert.deepEqual(splitTime('08:30'), {hour: 8, minute: 30});
  assert.deepEqual(splitTime('20:10'), {hour: 20, minute: 0});
  assert.deepEqual(splitTime('23:59'), {hour: 23, minute: 45});
  assert.deepEqual(splitTime('bad'), {hour: 0, minute: 0});
  assert.equal(joinTime(7, 45), '07:45');
  assert.equal(joinTime(0, 0), '00:00');
  for (const h of HOURS) for (const m of QUARTERS) assert.deepEqual(splitTime(joinTime(h, m)), {hour: h, minute: m});
});

test('the centred item follows the scroll position, rounded to the nearest row and clamped', () => {
  assert.equal(centredIndex(0, 24), 0);
  assert.equal(centredIndex(18 * 44, 24), 18);
  assert.equal(centredIndex(18 * 44 + 21, 24), 18);
  assert.equal(centredIndex(18 * 44 + 23, 24), 19);
  assert.equal(centredIndex(-30, 24), 0);
  assert.equal(centredIndex(99 * 44, 4), 3);
});

test('spinbutton keys step, page and jump to the ends without wrapping', () => {
  assert.equal(keyedIndex('ArrowUp', 18, 24, 6), 19);
  assert.equal(keyedIndex('ArrowDown', 18, 24, 6), 17);
  assert.equal(keyedIndex('ArrowUp', 23, 24, 6), 23);
  assert.equal(keyedIndex('ArrowDown', 0, 24, 6), 0);
  assert.equal(keyedIndex('PageUp', 20, 24, 6), 23);
  assert.equal(keyedIndex('PageDown', 3, 24, 6), 0);
  assert.equal(keyedIndex('Home', 2, 4, 2), 0);
  assert.equal(keyedIndex('End', 0, 4, 2), 3);
  assert.equal(keyedIndex('Enter', 2, 4, 2), null);
});
