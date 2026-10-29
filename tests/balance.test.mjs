import test from 'node:test';
import assert from 'node:assert/strict';
import {record, project} from '../lib/compensation/index.ts';
import {readBalance, relationships, signedPoints} from '../lib/supabase/balance.ts';

// The Team net shows the projection to the end of all published schedules,
// mirroring duty_private.balance(); the actual ledger is unchanged.
const FAR = Number.MAX_SAFE_INTEGER, NOW = Date.parse('2026-10-30T10:00:00Z');
const send = (history, operation, key) => record(history,
  {sourceKey: key, at: (history.at(-1)?.at ?? NOW - 100) + 1, actor: 'manager', reason: 'Reviewed', operation}).events;
const day = (date, primaryId) => ({startDate: date, endDate: new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10), primaryId, units: 2});
const november = (id, dana, intents = []) => ({id, month: '2026-11', reservations: [], intents,
  duties: [day('2026-11-02', 'avi'), day('2026-11-03', dana ? 'dana' : 'avi')]});
const publish = (h, after, beforeId = null) => send(h, {kind: 'publication', month: after.month, beforeId, after}, `publish/${after.id}`);
const transfer = id => ({id, kind: 'temporary', fromId: 'avi', toId: 'dana', capacity: [{date: '2026-11-03', offset: 0, units: 2}]});
const team = () => send([], {kind: 'members', members: [{id: 'avi', active: true}, {id: 'dana', active: true}]}, 'members');
const net = h => project(h, NOW, FAR).projected.net;

test('publishing a temporary transfer projects -1/+1 immediately; republishing without it returns to zero', () => {
  let h = publish(team(), november('v1', true, [transfer('avi-to-dana')]));
  assert.deepEqual(net(h), {avi: -2, dana: 2});
  h = publish(h, november('v2', false), 'v1');
  assert.deepEqual(net(h), {avi: 0, dana: 0});
});

test('a later published repayment returns the projection to zero while the actual debt stays until worked', () => {
  let h = publish(team(), november('v1', true, [transfer('avi-to-dana')]));
  const claim = project(h, NOW, NOW).actual.claims[0];
  h = publish(h, {id: 'dec', month: '2026-12', intents: [], duties: [day('2026-12-07', 'avi')],
    reservations: [{id: 'repay', capacity: {date: '2026-12-07', offset: 0, units: 2}, claim}]});
  const view = project(h, NOW, FAR);
  assert.deepEqual(view.projected.net, {avi: 0, dana: 0});
  assert.deepEqual(view.actual.net, {avi: -2, dana: 2});
  assert.equal(Object.values(view.projected.net).reduce((a, b) => a + b, 0), 0);
});

test('balance read model: strict shape, signed half points and one line per open relationship', () => {
  const raw = {net: {avi: -3, dana: 2, eli: 1}, lines: [
    {memberId: 'avi', counterpartId: 'dana', units: -2, kind: 'temporary', date: '2026-11-03', month: null},
    {memberId: 'avi', counterpartId: 'eli', units: -2, kind: 'temporary', date: '2026-11-10', month: null},
    {memberId: 'avi', counterpartId: 'eli', units: 1, kind: 'repayment', date: '2026-12-07', month: null},
    {memberId: 'dana', counterpartId: 'avi', units: 2, kind: 'temporary', date: '2026-11-03', month: null}]};
  const b = readBalance(raw);
  assert.deepEqual(relationships(b, 'avi').map(r => [r.counterpartId, r.units, r.lines.length]), [['dana', -2, 1], ['eli', -1, 2]]);
  assert.deepEqual(relationships(b, 'dana').map(r => r.counterpartId), ['avi']);
  assert.deepEqual([signedPoints(-2), signedPoints(1), signedPoints(0), signedPoints(3)], ['−1', '+0.5', '0', '+1.5']);
  for (const bad of [null, {net: {}}, {net: {a: 0.5}, lines: []}, {net: {}, lines: [{...raw.lines[0], kind: 'secret'}]},
    {net: {}, lines: [{...raw.lines[0], date: 'Nov 3'}]}]) assert.throws(() => readBalance(bad), /Invalid balance/);
});
