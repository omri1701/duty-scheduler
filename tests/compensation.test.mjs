import test from 'node:test';
import assert from 'node:assert/strict';
import {record, replay, normalize, halfUnits, sliceClaim, repaymentCandidates, reconcile, project,
  ledgerFingerprint} from '../lib/compensation/index.ts';
import {handover} from '../lib/scheduling/calendar.ts';

const end = date => handover(date) * 60000;
const send = (history, operation, key, at = (history.at(-1)?.at ?? 0) + 1) => record(history,
  {sourceKey: key, at, actor: 'manager', reason: 'Reviewed adjustment', operation}).events;
const setup = (ids = ['a', 'b', 'c', 'd']) => send([], {kind: 'members', members: ids.map(id => ({id, active: true}))}, 'members');
const owe = (h, debtorId, creditorId, units, key, at) => send(h, {kind: 'claim', debtorId, creditorId, units}, key, at);
const claims = h => replay(h).claims;
const amounts = h => claims(h).map(c => [c.debtorId, c.creditorId, c.units]).sort();
const duty = (date, primaryId, units = 2, endDate) => ({startDate: date,
  endDate: endDate ?? new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10), primaryId, units});
const publication = (id, month, duties, reservations = [], intents = []) => ({id, month, duties, reservations, intents});
const publish = (h, after, beforeId = null, key = `publish/${after.id}`, at) => send(h,
  {kind: 'publication', month: after.month, beforeId, after}, key, at);
const plan = (id, date, claim, units = claim.units, offset = 0) => ({id, capacity: {date, offset, units}, claim: sliceClaim(claim, units)});
const invariant = h => {
  const v = replay(h);
  assert.equal(Object.values(v.net).reduce((a, b) => a + b, 0), 0);
  assert.ok(v.claims.every(c => c.units > 0 && Number.isSafeInteger(c.units) && c.debtorId !== c.creditorId));
  assert.ok(v.lots.every(l => l.remaining >= 0));
  const rawNet = Object.fromEntries(v.members.map(m => [m.id, 0]));
  for (const l of v.lots) {rawNet[l.debtorId] -= l.remaining; rawNet[l.creditorId] += l.remaining;}
  assert.deepEqual(v.net, rawNet);
  return v;
};
function freeze(value) {
  if (value && typeof value === 'object') {Object.values(value).forEach(freeze); Object.freeze(value);}
  return value;
}

test('exact half units, valid endpoints, reasons and immutable/idempotent history', () => {
  assert.equal(halfUnits(34.5), 69);
  for (const n of [-1, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER]) assert.throws(() => halfUnits(n));
  const h = freeze(setup()), before = structuredClone(h);
  const command = {sourceKey: 'manual', at: 10, actor: 'manager', reason: 'Imported reviewed opening claim',
    operation: {kind: 'claim', debtorId: 'a', creditorId: 'b', units: 3}};
  const result = record(h, freeze(command));
  assert.deepEqual(h, before); assert.equal(result.net.a, -3);
  assert.deepEqual(record(result.events, {...command, at: 11}).events, result.events);
  assert.throws(() => record(result.events, {...command, operation: {...command.operation, units: 4}}), /source-key-conflict/);
  assert.throws(() => record(h, {...command, reason: ''}), /manual-reason-required/);
  for (const operation of [
    {...command.operation, units: 1.5}, {...command.operation, units: 0},
    {...command.operation, creditorId: 'a'}, {...command.operation, creditorId: 'missing'},
  ]) assert.throws(() => record(h, {...command, operation}));
  result.events[0].operation.members[0].active = false;
  assert.deepEqual(h, before, 'returned snapshots cannot mutate input history');
});

test('opposing claims, chains and partial transitive settlement preserve source legs and original priority', () => {
  let h = owe(setup(), 'a', 'b', 4, 'ab');
  h = owe(h, 'b', 'a', 2, 'ba');
  assert.deepEqual(amounts(h), [['a', 'b', 2]]);
  h = owe(h, 'b', 'c', 1, 'bc');
  assert.deepEqual(amounts(h), [['a', 'b', 1], ['a', 'c', 1]]);
  const transitive = claims(h).find(c => c.creditorId === 'c');
  assert.equal(transitive.priority.lotId, 'ab');
  h = send(h, {kind: 'adjust', mode: 'settle', claim: transitive, units: 1}, 'manual-settle');
  const v = invariant(h);
  assert.equal(v.lots.find(l => l.id === 'ab').remaining, 3);
  assert.equal(v.lots.find(l => l.id === 'bc').remaining, 0);
  assert.deepEqual(v.net, {a: -1, b: 1, c: 0, d: 0});
  assert.equal(v.settlements.length, 1);
  assert.throws(() => send(h, {kind: 'adjust', mode: 'settle', claim: transitive, units: 1}, 'again'), /claim-no-longer-outstanding/);
});

test('normalization eliminates cycles deterministically, preserves net and is idempotent', () => {
  const edge = (a, b, n, id, seq) => ({id, debtorId: a, creditorId: b, units: n,
    path: [{lotId: id, offset: 0, units: n}], priority: {at: 1, sequence: seq, lotId: id}, frozen: false});
  const active = new Set(['a', 'b', 'c', 'd']);
  const input = [edge('a', 'b', 4, 'ab', 1), edge('b', 'c', 2, 'bc', 2), edge('c', 'a', 1, 'ca', 3)];
  const first = normalize(input, active);
  assert.deepEqual(first.claims.map(c => [c.debtorId, c.creditorId, c.units]).sort(), [['a', 'b', 2], ['a', 'c', 1]]);
  assert.deepEqual(normalize([...input].reverse(), active), first);
  assert.deepEqual(normalize(first.claims, active).claims, first.claims);
  assert.ok(first.steps.some(s => s.kind === 'cycle'));
  assert.equal(normalize([edge('a', 'b', 1, 'x', 1), edge('b', 'c', 1, 'y', 2), edge('c', 'a', 1, 'z', 3)], active).claims.length, 0);
  // Independent net oracle on varied small graphs, with stable source identities.
  for (let seed = 1; seed <= 40; seed++) {
    let random = seed;
    const rand = () => (random = (Math.imul(random, 1664525) + 1013904223) >>> 0);
    const graph = Array.from({length: 9}, (_, i) => {
      const a = rand() % 4, b = (a + 1 + rand() % 3) % 4;
      return edge(String(a), String(b), 1 + rand() % 5, `s${i}`, i + 1);
    });
    const net = edges => edges.reduce((v, e) => {v[e.debtorId] -= e.units; v[e.creditorId] += e.units; return v;}, [0, 0, 0, 0]);
    const result = normalize(graph, new Set(['0', '1', '2', '3']));
    assert.deepEqual(net(result.claims), net(graph));
    assert.deepEqual(normalize([...graph].reverse(), new Set(['0', '1', '2', '3'])), result);
    assert.deepEqual(normalize(result.claims, new Set(['0', '1', '2', '3'])).claims, result.claims);
    assert.ok(!result.claims.some(a => result.claims.some(b => a.creditorId === b.debtorId)));
  }
});

test('manual increase is newly aged; reduction cannot cross zero; correction after normalization is appended', () => {
  let h = owe(setup(), 'a', 'b', 4, 'ab', 10);
  h = owe(h, 'b', 'c', 2, 'bc', 20);
  h = owe(h, 'a', 'd', 1, 'new', 30);
  assert.equal(repaymentCandidates(h)[0].priority.at, 10);
  const snapshot = structuredClone(h);
  h = send(h, {kind: 'correct', lotId: 'bc', deltaUnits: -2}, 'correct-bc', 40);
  assert.deepEqual(h.slice(0, snapshot.length), snapshot);
  assert.deepEqual(invariant(h).net, {a: -5, b: 4, c: 0, d: 1});
  assert.throws(() => send(h, {kind: 'correct', lotId: 'bc', deltaUnits: -1}, 'over-correct'), /invalid-units/);
  const ab = claims(h).find(c => c.creditorId === 'b');
  assert.throws(() => send(h, {kind: 'adjust', mode: 'reduce', claim: ab, units: ab.units + 1}, 'cross-zero'));
  h = send(h, {kind: 'adjust', mode: 'reduce', claim: ab, units: 1}, 'reduce');
  assert.equal(invariant(h).net.b, 3);
  assert.equal(replay(h).settlements.length, 0, 'a correction/reduction does not fabricate performed work');
});

test('participation freezes normalized endpoints rather than historical intermediary identities', () => {
  let h = owe(setup(), 'a', 'b', 4, 'ab');
  h = owe(h, 'b', 'c', 2, 'bc');
  h = send(h, {kind: 'members', members: [{id: 'b', active: false}]}, 'off');
  assert.equal(claims(h).find(c => c.creditorId === 'c').frozen, false);
  assert.equal(claims(h).find(c => c.creditorId === 'b').frozen, true);
  let frozen = send(setup(), {kind: 'members', members: [{id: 'b', active: false}]}, 'off');
  frozen = owe(frozen, 'a', 'b', 4, 'ab'); frozen = owe(frozen, 'b', 'c', 2, 'bc');
  assert.deepEqual(amounts(frozen), [['a', 'b', 4], ['b', 'c', 2]]);
  assert.ok(claims(frozen).every(c => c.frozen));
  frozen = send(frozen, {kind: 'members', members: [{id: 'b', active: true}, {id: 'new', active: true}]}, 'on');
  assert.deepEqual(amounts(frozen), [['a', 'b', 2], ['a', 'c', 2]]);
  assert.equal(invariant(frozen).net.new, 0);
  // Late correction does not retroactively unfreeze/reroute the previously committed graph.
  h = send(h, {kind: 'correct', lotId: 'bc', deltaUnits: -1}, 'late');
  assert.ok(claims(h).some(c => c.debtorId === 'c' && c.creditorId === 'b' && c.frozen));
  invariant(h);
});

test('exclusive future reservations across months, partial slices and oldest candidate priority', () => {
  let h = owe(setup(), 'a', 'b', 4, 'old', 10);
  h = owe(h, 'a', 'c', 2, 'young', 20);
  const old = claims(h).find(c => c.creditorId === 'b');
  const nov = publication('nov', '2026-11', [duty('2026-11-02', 'a')], [plan('r1', '2026-11-02', old, 2)]);
  h = publish(h, nov);
  assert.equal(replay(h).net.a, -6);
  const candidates = repaymentCandidates(h);
  assert.deepEqual(candidates.map(c => [c.creditorId, c.units]), [['b', 2], ['c', 2]]);
  assert.equal(candidates[0].path[0].offset, 2);
  assert.throws(() => publish(h, publication('dec', '2026-12', [duty('2026-12-01', 'a')], [plan('r2', '2026-12-01', old, 1)])), /claim-already-reserved/);
  h = publish(h, publication('dec', '2026-12', [duty('2026-12-01', 'a')], [plan('r2', '2026-12-01', candidates[0], 2)]));
  assert.deepEqual(repaymentCandidates(h).map(c => [c.creditorId, c.units]), [['c', 2]]);
  assert.equal(project(h, 100, end('2026-11-03')).projected.net.a, -4);
  invariant(h);
});

test('actual vs projected, exact completion, lazy replay, copies, deletion and idempotency', () => {
  let h = owe(setup(), 'a', 'b', 4, 'debt');
  const p = publication('v1', '2026-10', [duty('2026-10-30', 'a', 2, '2026-11-01')],
    [plan('friday', '2026-10-30', claims(h)[0], 1)]);
  h = publish(h, p);
  assert.equal(project(h, 100, end('2026-10-31')).projected.net.a, -4, 'combined weekend cannot earn halfway');
  const before = structuredClone(h), projected = project(h, 100, end('2026-11-01'));
  assert.equal(projected.actual.net.a, -4); assert.equal(projected.projected.net.a, -3);
  assert.deepEqual(h, before); assert.equal(projected.actual.events.length, h.length);
  h = publish(h, {...p, id: 'v2'}, 'v1');
  assert.equal(replay(h).contributions.length, 1);
  assert.equal(reconcile(h, end('2026-11-01') - 1).net.a, -4);
  let earned = reconcile(h, end('2026-11-01'));
  assert.equal(earned.net.a, -3); assert.equal(earned.settlements.length, 1);
  assert.deepEqual(reconcile(earned.events, end('2026-11-02')).events, earned.events);
  earned = replay([...earned.events].reverse());
  assert.equal(earned.net.a, -3, 'physical input row order is not business order');
  h = send(earned.events, {kind: 'publication', month: p.month, beforeId: 'v2', after: null}, 'delete', end('2026-11-02'));
  assert.equal(replay(h).net.a, -3); assert.equal(replay(h).publications.length, 0);
  assert.equal(replay(h).contributions[0].status, 'settled');
  invariant(h);
});

test('freeze reconciles earned work first; completion during freeze stays held after reactivation', () => {
  const make = () => {
    let h = owe(setup(), 'a', 'b', 2, 'debt');
    h = publish(h, publication('v', '2026-11', [duty('2026-11-02', 'a')], [plan('r', '2026-11-02', claims(h)[0], 2)]));
    return h;
  };
  let h = send(make(), {kind: 'members', members: [{id: 'a', active: false}]}, 'off', end('2026-11-03'));
  assert.equal(replay(h).net.a, 0);
  h = send(make(), {kind: 'members', members: [{id: 'b', active: false}]}, 'off', end('2026-11-02'));
  assert.equal(project(h, end('2026-11-02'), end('2026-11-04')).projected.net.a, -2);
  h = send(h, {kind: 'members', members: [{id: 'b', active: true}]}, 'on', end('2026-11-04'));
  const v = reconcile(h, end('2026-11-05'));
  assert.equal(v.net.a, -2); assert.equal(v.contributions[0].status, 'held');
  assert.equal(v.contributions[0].holdReason, 'inactive');
  assert.equal(repaymentCandidates(v.events).length, 0, 'held slices require explicit release/resolution');
  h = send(v.events, {kind: 'release', contributionId: 'r'}, 'review-held');
  assert.equal(repaymentCandidates(h)[0].units, 2);
});

test('ordinary replacement, weighted/equal swaps and stable copied publications charge once', () => {
  let h = publish(setup(), publication('v1', '2026-11', [duty('2026-11-02', 'a', 2), duty('2026-11-04', 'b', 6)]));
  assert.equal(claims(h).length, 0);
  const swapped = publication('v2', '2026-11', [duty('2026-11-02', 'b', 2), duty('2026-11-04', 'a', 6)]);
  h = publish(h, swapped, 'v1');
  assert.deepEqual(amounts(h), [['b', 'a', 4]]);
  assert.equal(replay(h).lots.length, 1);
  h = publish(h, {...swapped, id: 'copy'}, 'v2');
  assert.equal(replay(h).lots.length, 1);
  assert.throws(() => publish(h, {...swapped, id: 'stale'}, 'v1'), /stale-publication/);
  let equal = publish(setup(), publication('e1', '2026-11', [duty('2026-11-02', 'a'), duty('2026-11-04', 'b')]));
  equal = publish(equal, publication('e2', '2026-11', [duty('2026-11-02', 'b'), duty('2026-11-04', 'a')]), 'e1');
  assert.equal(claims(equal).length, 0);
  let replacement = publish(setup(), publication('p1', '2026-11', [duty('2026-11-02', 'a', 4)]));
  replacement = publish(replacement, publication('p2', '2026-11', [duty('2026-11-02', 'b', 4)]), 'p1');
  assert.deepEqual(amounts(replacement), [['a', 'b', 4]]); invariant(replacement);
});

test('cancelled repayment plus separate ordinary capacity: debt stays 2 or becomes 3 points, never 4 or 5', () => {
  for (const weight of [4, 6]) {
    let h = owe(setup(), 'a', 'b', 4, 'debt');
    const p = publication('p1', '2026-11', [duty('2026-11-02', 'a', weight)], [plan('r', '2026-11-02', claims(h)[0], 4)]);
    h = publish(h, p);
    assert.equal(project(h, 100, end('2026-11-03')).projected.net.a, 0);
    const changed = publication('p2', p.month, [duty('2026-11-02', 'b', weight)]);
    h = publish(h, changed, 'p1');
    assert.equal(replay(h).net.a, -weight);
    assert.equal(replay(h).contributions[0].status, 'cancelled');
    h = publish(h, {...changed, id: 'p3'}, 'p2');
    assert.equal(reconcile(h, end('2026-11-04')).net.a, -weight);
    assert.equal(replay(h).settlements.length, 0); invariant(h);
  }
});

test('third-party replacement reroutes repayment through the creditor without duplicating debtor shortfall', () => {
  let h = owe(setup(), 'a', 'b', 4, 'debt');
  h = publish(h, publication('p1', '2026-11', [duty('2026-11-02', 'a', 4)], [plan('r', '2026-11-02', claims(h)[0], 4)]));
  h = publish(h, publication('p2', '2026-11', [duty('2026-11-02', 'c', 4)]), 'p1');
  assert.deepEqual(amounts(h), [['a', 'c', 4]]);
  assert.equal(claims(h)[0].priority.lotId, 'debt'); invariant(h);
});

test('permanent replacement of repayment capacity cancels the plan without a new claim or forgiveness', () => {
  let h = owe(setup(), 'a', 'b', 2, 'debt');
  h = publish(h, publication('p1', '2026-11', [duty('2026-11-02', 'a')], [plan('r', '2026-11-02', claims(h)[0], 2)]));
  const permanent = {id: 'volunteer', kind: 'permanent', fromId: 'a', toId: 'c',
    capacity: [{date: '2026-11-02', offset: 0, units: 2}]};
  h = publish(h, publication('p2', '2026-11', [duty('2026-11-02', 'c')], [], [permanent]), 'p1');
  assert.deepEqual(amounts(h), [['a', 'b', 2]]);
  assert.equal(replay(h).contributions[0].status, 'cancelled');
  assert.equal(reconcile(h, end('2026-11-04')).net.a, -2); invariant(h);
});

test('explicit temporary/permanent intents are funded, exclusive and applied once; exemptions do not follow future replacements', () => {
  const temp = {id: 'temp', kind: 'temporary', fromId: 'a', toId: 'c', capacity: [{date: '2026-11-02', offset: 0, units: 2}]};
  const perm = {id: 'perm', kind: 'permanent', fromId: 'b', toId: 'c', capacity: [{date: '2026-11-04', offset: 0, units: 2}]};
  const p = publication('v1', '2026-11', [duty('2026-11-02', 'c'), duty('2026-11-04', 'c')], [], [temp, perm]);
  let h = publish(setup(), p);
  assert.deepEqual(amounts(h), [['a', 'c', 2]]);
  h = publish(h, {...p, id: 'v2'}, 'v1');
  assert.equal(replay(h).lots.length, 1);
  h = publish(h, {...p, id: 'v3', duties: [duty('2026-11-02', 'c'), duty('2026-11-04', 'd')]}, 'v2');
  assert.equal(replay(h).net.c, 0); assert.equal(replay(h).net.d, 2);
  let debt = owe(setup(), 'c', 'b', 2, 'debt');
  const overlap = plan('r', '2026-11-02', claims(debt)[0], 2);
  assert.throws(() => publish(debt, {...p, reservations: [overlap]}), /overlapping-accounting-capacity/);
  assert.throws(() => publish(setup(), {...p, intents: [temp, {...perm, id: 'overlap', capacity: temp.capacity}]}), /overlapping-accounting-capacity/);
  invariant(h);
});

test('correction of reserved/earned normalized claims holds stale plans and preserves completed capacity on reversal', () => {
  let h = owe(setup(), 'a', 'b', 2, 'ab'); h = owe(h, 'b', 'c', 2, 'bc');
  h = publish(h, publication('p', '2026-11', [duty('2026-11-02', 'a')], [plan('r', '2026-11-02', claims(h)[0], 2)]));
  const corrected = send(h, {kind: 'correct', lotId: 'bc', deltaUnits: -2}, 'fix');
  assert.equal(replay(corrected).contributions[0].status, 'held');
  assert.equal(project(corrected, 100, end('2026-11-04')).projected.net.a, -2);
  let earned = reconcile(h, end('2026-11-03'));
  assert.equal(earned.net.a, 0);
  h = send(earned.events, {kind: 'correct', lotId: 'bc', deltaUnits: -2}, 'historical-fix');
  assert.deepEqual(invariant(h).net, {a: 0, b: 2, c: -2, d: 0});
  h = send(h, {kind: 'reverse-settlement', settlementId: '@earned/r'}, 'reverse');
  assert.equal(replay(h).net.a, -2); assert.equal(replay(h).net.c, 0);
  assert.throws(() => send(h, {kind: 'reverse-settlement', settlementId: '@earned/r'}, 'twice'), /invalid-settlement-reversal/);
  earned = reconcile(h, end('2026-11-05'));
  assert.equal(earned.settlements.length, 1); assert.equal(earned.contributions[0].status, 'settled'); invariant(h);
});

test('combined/split cross-year ownership, final block completion and shared weight changes', () => {
  let h = publish(setup(), publication('dec1', '2027-12', [duty('2027-12-31', 'a', 2, '2028-01-02')]));
  h = publish(h, publication('dec2', '2027-12', [duty('2027-12-31', 'a', 1), duty('2028-01-01', 'b', 1)]), 'dec1');
  assert.deepEqual(amounts(h), [['a', 'b', 1]]);
  assert.throws(() => publish(h, publication('bad', '2028-01', [duty('2028-01-01', 'a', 1)])), /invalid-published-duty/);
  let weighted = publish(setup(), publication('w1', '2026-11', [duty('2026-11-02', 'a', 6)]));
  weighted = publish(weighted, publication('w2', '2026-11', [duty('2026-11-02', 'b', 4)]), 'w1');
  assert.deepEqual(amounts(weighted), [['a', 'b', 4]], 'only shared old/new committed weight transfers');
  weighted = publish(weighted, publication('w3', '2026-11', [duty('2026-11-02', 'b', 2)]), 'w2');
  assert.deepEqual(amounts(weighted), [['a', 'b', 4]], 'removed weight has no invented counterparty');
  assert.throws(() => publish(weighted, publication('past', '2026-11', [duty('2026-11-02', 'c', 2)]), 'w3', 'past-change', end('2026-11-04')), /historical-publication-change/);
  invariant(h); invariant(weighted);
});

test('fingerprints preserve committed order; stale or forged derived events are rejected', () => {
  let h = owe(setup(), 'a', 'b', 2, 'ab'); h = owe(h, 'b', 'c', 2, 'bc');
  assert.equal(ledgerFingerprint(h), ledgerFingerprint([...h].reverse()));
  const changed = structuredClone(h); changed[1].operation.units = 3;
  assert.notEqual(ledgerFingerprint(h), ledgerFingerprint(changed));
  assert.throws(() => replay([...h, {...h[1], operation: {...h[1].operation, units: 8}}]), /source-key-conflict/);
  assert.throws(() => replay([...h, {sourceKey: '@earned/fake', at: 100, sequence: 4, actor: 'system', operation: {kind: 'earned', contributionId: 'fake'}}]), /unearned-settlement/);
});

test('section 16.5 deferral leaves exactly one residual point through the approved counterpart chain', () => {
  const original = owe(setup(), 'a', 'b', 6, 'debt');
  const intent = {id: 'deferred', kind: 'temporary', fromId: 'b', toId: 'c',
    capacity: [{date: '2026-11-04', offset: 0, units: 2}]};
  const p = publication('v1', '2026-11', [duty('2026-11-02', 'a', 4), duty('2026-11-04', 'c')], [], [intent]);
  // Pure preview of the same operation supplies post-transfer source references; it is not persisted.
  const preview = publish(original, p), retained = claims(preview).find(c => c.creditorId === 'b');
  let h = publish(original, {...p, reservations: [plan('repay', '2026-11-02', retained, 4)]});
  h = reconcile(h, end('2026-11-03')).events;
  assert.deepEqual(amounts(h), [['a', 'c', 2]]);
  assert.equal(claims(h)[0].priority.lotId, 'debt'); invariant(h);
});

test('reviewed weight decrease shrinks future capacity without charging it or changing another published month', () => {
  let h = owe(setup(), 'a', 'b', 4, 'debt');
  const p = publication('oct1', '2026-10', [duty('2026-10-30', 'a', 2)], [plan('r1', '2026-10-30', claims(h)[0], 2)]);
  h = publish(h, p);
  const november = publication('nov', '2026-11', [duty('2026-11-02', 'c')]);
  h = publish(h, november);
  const revised = publication('oct2', p.month, [duty('2026-10-30', 'a', 1)], [plan('r2', '2026-10-30', claims(h)[0], 1)]);
  h = publish(h, revised, 'oct1');
  assert.equal(project(h, 100, end('2026-11-01')).projected.net.a, -3);
  assert.equal(reconcile(h, end('2026-10-31')).net.a, -3);
  assert.deepEqual(replay(h).publications.find(p => p.month === '2026-11'), november);
  assert.equal(replay(h).lots.length, 1);
});

test('a blocked old claim can be deferred while a later one progresses; residual age never resets', () => {
  let h = owe(setup(), 'a', 'b', 3, 'old', 10); h = owe(h, 'c', 'd', 2, 'later', 20);
  const later = repaymentCandidates(h).find(c => c.debtorId === 'c');
  h = publish(h, publication('p', '2026-11', [duty('2026-11-02', 'c')], [plan('later-plan', '2026-11-02', later, 1)]));
  h = reconcile(h, end('2026-11-03')).events;
  assert.deepEqual(repaymentCandidates(h).map(c => [c.priority.at, c.units]), [[10, 3], [20, 1]]);
  invariant(h);
});

test('publication row ordering is irrelevant to transfer provenance; failed operations are atomic', () => {
  const source = publication('v1', '2026-11', [duty('2026-11-02', 'a'), duty('2026-11-04', 'b', 6)]);
  const target = publication('v2', source.month, [duty('2026-11-02', 'b'), duty('2026-11-04', 'a', 6)]);
  const a = publish(publish(setup(), source), target, 'v1');
  const b = publish(publish(setup(), {...source, duties: [...source.duties].reverse()}), {...target, duties: [...target.duties].reverse()}, 'v1');
  assert.deepEqual(claims(a), claims(b)); assert.deepEqual(replay(a).lots, replay(b).lots);
  const before = structuredClone(a);
  assert.throws(() => publish(a, {...target, duties: [duty('2026-11-02', 'c')]}, 'v2', 'mutate-id'), /immutable-publication/);
  assert.deepEqual(a, before);
});

test('a new intent ID cannot charge unchanged published capacity a second time', () => {
  const intent = {id: 'temp', kind: 'temporary', fromId: 'a', toId: 'b',
    capacity: [{date: '2026-11-02', offset: 0, units: 2}]};
  const p = publication('v1', '2026-11', [duty('2026-11-02', 'b')], [], [intent]);
  const h = publish(setup(), p);
  assert.throws(() => publish(h, {...p, id: 'v2', intents: [{...intent, id: 'new-id'}]}, 'v1'), /unchanged-capacity-intent/);
  assert.throws(() => publish(h, {...p, id: 'v2', intents: [{...intent, fromId: 'c'}]}, 'v1'), /intent-lineage-changed/);
  assert.equal(replay(h).lots.length, 1);
});

test('varied sequential graph changes and partial settlements conserve raw and normalized positions', () => {
  for (let seed = 1; seed <= 8; seed++) {
    let random = seed, h = setup();
    const rand = () => (random = (Math.imul(random, 1664525) + 1013904223) >>> 0);
    for (let i = 0; i < 24; i++) {
      const current = claims(h);
      if (rand() % 4 === 0 && current.length) {
        const c = current[rand() % current.length];
        h = send(h, {kind: 'adjust', mode: 'settle', claim: c, units: 1 + rand() % c.units}, `s${i}`);
      } else {
        const a = rand() % 4, b = (a + 1 + rand() % 3) % 4;
        h = owe(h, 'abcd'[a], 'abcd'[b], 1 + rand() % 5, `lot${i}`);
      }
      invariant(h);
    }
  }
});

test('deleting a live version may select known history without changing completed accounting or resurrecting cancelled plans', () => {
  let h = owe(setup(), 'a', 'b', 2, 'debt');
  const old = publication('v1', '2026-11', [duty('2026-11-02', 'a')], [plan('r', '2026-11-02', claims(h)[0], 2)]);
  h = publish(h, old);
  h = publish(h, publication('v2', old.month, [duty('2026-11-02', 'b')]), 'v1');
  h = send(h, {kind: 'publication', mode: 'delete', month: old.month, beforeId: 'v2', after: old}, 'delete-current', end('2026-11-04'));
  assert.equal(replay(h).net.a, -2); assert.equal(replay(h).contributions[0].status, 'cancelled');
  assert.equal(replay(h).settlements.length, 0);
  assert.equal(replay(h).publications[0].id, 'v1');
  assert.equal(reconcile(h, end('2026-11-05')).net.a, -2);
  assert.throws(() => send(h, {kind: 'publication', mode: 'delete', month: old.month, beforeId: 'v1', after: {...old, id: 'unknown'}}, 'forged-delete'), /invalid-publication-deletion/);
});

test('a DST weekend earns at the actual Jerusalem end instant, not 48 hours after its start', () => {
  assert.equal(end('2026-10-25') - end('2026-10-23'), 49 * 3600000);
  let h = owe(setup(), 'a', 'b', 2, 'debt');
  h = publish(h, publication('dst', '2026-10', [duty('2026-10-23', 'a', 2, '2026-10-25')], [plan('r', '2026-10-23', claims(h)[0], 1)]));
  assert.equal(reconcile(h, end('2026-10-23') + 48 * 3600000).net.a, -2);
  assert.equal(reconcile(h, end('2026-10-25')).net.a, -1);
});

test('normalization rejects reused source capacity and malformed partial path references', () => {
  const h = owe(setup(), 'a', 'b', 2, 'debt'), c = claims(h)[0];
  assert.throws(() => normalize([c, c], new Set(['a', 'b'])), /overlapping-source-slices/);
  assert.throws(() => normalize([{...c, priority: {...c.priority, at: NaN}}], new Set(['a', 'b'])), /invalid-priority/);
  assert.throws(() => sliceClaim({...c, path: [...c.path, {...c.path[0], units: 1}]}, 1), /invalid-path/);
});
