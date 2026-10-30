import test from 'node:test';
import assert from 'node:assert/strict';
import {nettedCompensation} from '../lib/allocation/netting.ts';

const order = ['a', 'b', 'c', 'd'];
const temporary = (fromId, toId, units, kind = 'temporary') => ({id: `${fromId}-${toId}-${units}-${kind}`, fromId, toId, units, kind});
const repay = (debtorId, creditorId, units) => ({claim: {debtorId, creditorId, units, path: [], priority: {at: 0, sequence: 0, lotId: 'l'}}, units});
const lines = (opening, transfers = [], repayments = [], uneven = []) => nettedCompensation(opening, {transfers, repayments, uneven}, order);

test('a chain collapses: A owes B and B owes C shows A → C only', () => {
  // Opening: A owes B one point. This month B is relieved one point carried by C.
  assert.deepEqual(lines({a: -2, b: 2}, [temporary('b', 'c', 2)]),
    [{debtorId: 'a', creditorId: 'c', units: 2, thisMonth: 0, later: 2}]);
});

test('opposite directions cancel', () => {
  assert.deepEqual(lines({a: -2, b: 2}, [temporary('b', 'a', 2)]), []);
  assert.deepEqual(lines({a: -4, b: 4}, [temporary('b', 'a', 2)]),
    [{debtorId: 'a', creditorId: 'b', units: 2, thisMonth: 0, later: 2}]);
});

test('partial repayment splits this month and later', () => {
  assert.deepEqual(lines({a: -4, c: 4}, [], [repay('a', 'c', 2)]),
    [{debtorId: 'a', creditorId: 'c', units: 4, thisMonth: 2, later: 2}]);
  assert.deepEqual(lines({a: -4, c: 4}, [], [repay('a', 'c', 4)]),
    [{debtorId: 'a', creditorId: 'c', units: 4, thisMonth: 4, later: 0}]);
});

test('permanent transfers create no compensation; half points are kept', () => {
  assert.deepEqual(lines({}, [temporary('a', 'b', 2, 'permanent')]), []);
  assert.deepEqual(lines({}, [temporary('a', 'b', 1)]), [{debtorId: 'a', creditorId: 'b', units: 1, thisMonth: 0, later: 1}]);
});

test('repayment against the net direction carries the full amount forward', () => {
  // A repays B one point while B is newly relieved two points carried by A.
  assert.deepEqual(lines({a: -2, b: 2}, [temporary('b', 'a', 4)], [repay('a', 'b', 2)]),
    [{debtorId: 'b', creditorId: 'a', units: 4, thisMonth: 0, later: 4}]);
});

test('uneven-month credit is owed back like a temporary transfer and names its reason', () => {
  const credit = {id: 'uneven/a/c', fromId: 'a', toId: 'c', units: 1};
  assert.deepEqual(lines({}, [], [], [credit]), [{debtorId: 'a', creditorId: 'c', units: 1, thisMonth: 0, later: 1, reason: 'uneven'}]);
  // Opposite directions still cancel; a merged line keeps the reason only for the credited pair.
  assert.deepEqual(lines({a: 1, c: -1}, [], [], [credit]), []);
  assert.deepEqual(lines({}, [temporary('a', 'c', 2)], [], [credit]), [{debtorId: 'a', creditorId: 'c', units: 3, thisMonth: 0, later: 3, reason: 'uneven'}]);
  assert.equal(lines({}, [temporary('b', 'd', 2)], [], [credit]).find(l => l.debtorId === 'b').reason, undefined);
});

test('ties follow the given order and totals balance', () => {
  const result = lines({a: -2, b: -2, c: 2, d: 2});
  assert.deepEqual(result.map(l => `${l.debtorId}>${l.creditorId}`), ['a>c', 'b>d']);
});
