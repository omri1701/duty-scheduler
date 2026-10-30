import test from 'node:test';
import assert from 'node:assert/strict';
import loadHighs from 'highs';
import {createHighsAdapter, canonicalDuties, createGenerationRequest, solveGeneration} from '../lib/scheduling/index.ts';
import {record, replay, sliceClaim, project} from '../lib/compensation/index.ts';
import {proposeAllocation, allocationCeilings, editAllocation, compileAllocation, persistedDraft, transferAllocation, classifyTransfer,
  fitPartition, equalShares, unevenBaseline, unevenTransfers, bindAllocation} from '../lib/allocation/index.ts';
import {monthScenario} from './fixtures/generation.mjs';

// Allocation is solver-free; only Generate's own solver supplies actual assignments.
const solver = await createHighsAdapter(loadHighs);
const total = xs => xs.reduce((a, b) => a + b, 0);
const send = (h, operation, sourceKey, at = (h.at(-1)?.at ?? 0) + 1) => record(h,
  {operation, sourceKey, at, actor: 'manager', reason: 'Reviewed fixture'}).events;
function scenario(kind = 'normal') {
  const {input, now} = monthScenario(kind), schedule = structuredClone(input); delete schedule.targets;
  return {schedule, now, seniority: schedule.members.map(m => m.id), events: send([], {
    kind: 'members', members: schedule.members.map(m => ({id: m.id, active: true})),
  }, 'members')};
}
const owe = (i, debtorId, creditorId, units, id) => {
  i.events = send(i.events, {kind: 'claim', debtorId, creditorId, units}, id); return i;
};
const proposal = i => proposeAllocation(i);
const edit = (i, d, engineer, deltaUnits, kind = 'temporary', id = 'edit') =>
  editAllocation(i, d, {id, engineer, deltaUnits, kind});
const generated = (i, d) => solveGeneration(solver, createGenerationRequest({...i.schedule,
  targets: Object.fromEntries(Object.entries(d.targetsUnits).map(([k, v]) => [k, v / 2]))}, {now: i.now, seed: 17, seconds: 4})).assignments;
const compiled = (i, d, assignments = generated(i, d)) => compileAllocation(i, d, assignments);
function invariant(i, r) {
  const duties = canonicalDuties(i.schedule.month, i.schedule.calendar), locked = {};
  for (const l of i.schedule.locks ?? []) locked[l.engineer] = (locked[l.engineer] ?? 0) + duties.find(d => d.id === l.dutyId).units;
  assert.equal(total(Object.values(r.draft.baselineUnits)), total(duties.map(d => d.units)));
  assert.equal(total(Object.values(r.draft.targetsUnits)), total(duties.map(d => d.units)));
  for (const [id, units] of Object.entries(r.draft.targetsUnits)) assert.ok(units >= (locked[id] ?? 0), `${id} keeps its locked floor`);
  assert.deepEqual(r.draft.pending, []);
}
function freeze(v) {if (v && typeof v === 'object') {Object.values(v).forEach(freeze); Object.freeze(v);} return v;}

const normalInput = freeze(scenario()), normal = proposal(normalInput);

test('ordinary baseline uses exact attainable weights; saved seniority only breaks equivalent choices', () => {
  invariant(normalInput, normal);
  assert.deepEqual(proposal(normalInput), normal, 'deterministic');
  assert.deepEqual(Object.values(normal.draft.baselineUnits), [...Array(10).fill(4), 6, 6]);
  assert.deepEqual(normal.draft.transfers, []);
  const p = compiled(normalInput, normal.draft);
  assert.deepEqual(p.plan.intents, []); assert.deepEqual(p.plan.repayments, []);
  assert.equal(p.confirmable, true);
  // Independent enumeration of canonical whole-point partitions for this average.
  const cost = bs => total(bs.map(b => (12 * b - 52) ** 2));
  assert.equal(cost(Object.values(normal.draft.baselineUnits)), 960);
  for (let a = 0; a <= 52; a += 2) for (let b = 0; b <= 52 - a; b += 2) {
    const rest = 52 - a - b, low = Math.floor(rest / 20) * 2;
    const remainder = (rest - 10 * low) / 2;
    if (remainder >= 0 && remainder <= 10) assert.ok(cost([a, b, ...Array(10 - remainder).fill(low), ...Array(remainder).fill(low + 2)]) >= 960);
  }
});

// Literal ports of duty_private.allocation_partition and allocation_better_baseline:
// the browser baseline must be one the checked confirm RPC accepts.
function sqlPartition(weights, capacities) {
  if (!weights.length) return capacities.every(x => x === 0);
  let previous = -1;
  for (let i = 0; i < capacities.length; i++) {
    if (capacities[i] < weights[0] || capacities[i] === previous) continue;
    previous = capacities[i]; const next = [...capacities]; next[i] -= weights[0];
    if (sqlPartition(weights.slice(1), next.sort((a, b) => b - a))) return true;
  }
  return false;
}
function sqlBetter(weights, bins, ceiling, quantum, sum) {
  const n = bins.length, relaxed = [...bins];
  for (let i = 0; i < total(weights) / quantum; i++) relaxed[relaxed.indexOf(Math.min(...relaxed))] += quantum;
  if (relaxed.reduce((s, x) => s + (n * x - sum) ** 2, 0) >= ceiling) return false;
  if (!weights.length) return true;
  let previous = -1;
  for (let i = 0; i < n; i++) {
    if (bins[i] === previous) continue; previous = bins[i];
    const next = [...bins]; next[i] += weights[0];
    if (sqlBetter(weights.slice(1), next.sort((a, b) => a - b), ceiling, quantum, sum)) return true;
  }
  return false;
}
function sqlAccepts(weights, baseline) {
  const w = [...weights].sort((a, b) => b - a), capacities = Object.values(baseline).sort((a, b) => b - a), n = capacities.length;
  const gcd = (a, b) => b ? gcd(b, a % b) : a, sum = total(w);
  const cost = capacities.reduce((s, x) => s + (n * x - sum) ** 2, 0);
  return sqlPartition(w, capacities) && !sqlBetter(w, Array(n).fill(0), cost, w.reduce(gcd, 0), sum);
}
const holiday = (extra = 2) => {
  const i = scenario(); i.schedule.calendar = {specials: [{id: 'holiday', start: '2026-11-01', end: '2026-11-15', extra}]}; return i;
};
const weightsOf = i => canonicalDuties(i.schedule.month, i.schedule.calendar).map(d => d.units);

test('a normal month keeps the plain equal split, which the database accepts', () => {
  const weights = weightsOf(normalInput);
  assert.deepEqual(fitPartition(weights, 12), equalShares(weights, 12));
  assert.ok(sqlAccepts(weights, normal.draft.baselineUnits));
  assert.deepEqual(unevenBaseline(normalInput, normal.draft.baselineUnits), []);
});

test('indivisible holiday duties fit the cheapest exact partition; extra goes to the newest', () => {
  // 14 days at +2: ten 3-point weekdays and four 2.5-point weekend days among 12.
  const i = holiday(), weights = weightsOf(i), r = proposal(i);
  invariant(i, r);
  const plain = Object.fromEntries(i.seniority.map((id, k) => [id, equalShares(weights, 12)[k]]));
  assert.deepEqual(Object.values(plain), Array(12).fill(9));
  assert.equal(sqlAccepts(weights, plain), false, 'the equal split is not a real partition');
  assert.deepEqual(i.seniority.map(id => r.draft.baselineUnits[id]), [...Array(6).fill(8), ...Array(6).fill(10)]);
  assert.ok(sqlAccepts(weights, r.draft.baselineUnits), 'database rules accept the fitted baseline');
  assert.deepEqual(r.draft.targetsUnits, r.draft.baselineUnits);
  assert.deepEqual(unevenBaseline(i, r.draft.baselineUnits).map(u => u.id), i.seniority.slice(6));
  assert.deepEqual(proposal(i), r, 'deterministic');
  // Small cases against the same SQL rules.
  let seed = 11; const next = k => (seed = (seed * 1103515245 + 12345) % 2147483648) % k;
  for (let k = 0; k < 300; k++) {
    const w = Array.from({length: 1 + next(8)}, () => 1 + next(7)), n = 1 + next(4);
    assert.ok(sqlAccepts(w, fitPartition(w, n)), `${w} into ${n}`);
  }
});

test('the exact fit is bounded and reports a clear limit instead of freezing', () => {
  assert.throws(() => fitPartition(weightsOf(holiday()), 12, 10), /allocation-fit-limit/);
  assert.ok(fitPartition(weightsOf(holiday(1)), 12).length === 12);
});

// Decision 2026-10-30: the people who carry more in an indivisible month are
// compensated. The credit is system temporary work, not a baseline change.
const pair = (k, units = 1) => ({id: `uneven/e0${k}/e${String(k + 6).padStart(2, '0')}`, fromId: `e0${k}`, toId: `e${String(k + 6).padStart(2, '0')}`, units});
// Six members and seven +2 days: the only uneven month the solver covers completely.
const sixHoliday = () => {
  const i = scenario(); i.schedule.members = i.schedule.members.slice(0, 6); i.seniority = i.seniority.slice(0, 6);
  i.events = send([], {kind: 'members', members: i.schedule.members.map(m => ({id: m.id, active: true}))}, 'members');
  i.schedule.calendar = {specials: [{id: 'holiday', start: '2026-11-01', end: '2026-11-08', extra: 2}]}; return i;
};
test('an uneven month credits each extra half point from the fewest-points members to those above the equal share', () => {
  const i = holiday(), r = proposal(i);
  assert.deepEqual(r.draft.uneven, [0, 1, 2, 3, 4, 5].map(k => pair(k)), 'six most senior (4 pts) each owe one of the six newest (5 pts) half a point');
  assert.deepEqual(r.draft.targetsUnits, r.draft.baselineUnits, 'targets and the stored baseline are unchanged');
  assert.deepEqual(normal.draft.uneven, [], 'a normal month creates no credit');
  const six = sixHoliday(), s = proposal(six);
  assert.deepEqual(six.seniority.map(id => s.draft.baselineUnits[id]), [12, 13, 13, 14, 14, 14]);
  assert.deepEqual(s.draft.uneven, [{id: 'uneven/e00/e03', fromId: 'e00', toId: 'e03', units: 1}], 'the most senior 7-point member is owed by the 6-point member');
  assert.deepEqual(unevenBaseline(six, s.draft.baselineUnits), [{id: 'e03', units: 14}], 'the inline note names the same creditor');
  const p = compiled(six, s.draft);
  assert.equal(p.check.feasibility, 'complete'); assert.equal(p.confirmable, true);
  assert.deepEqual(p.plan.intents, [{fromId: 'e00', toId: 'e03', units: 1, kind: 'temporary', transferIds: ['uneven/e00/e03']}], 'publication intent: the creditor carries the debtor\'s half point');
  assert.deepEqual(p.plan.funding.map(f => f.carrierId), ['e03']); assert.deepEqual(p.plan.repayments, []);
});

test('uneven credit ties: the remainder itself is never debt; equal points pick the most senior', () => {
  const flat = Array(38).fill(1), ids = ['a', 'b', 'c', 'd']; // plain split 9, 9, 10, 10
  assert.deepEqual(unevenTransfers(ids, flat, {a: 9, b: 9, c: 9, d: 11}), [{id: 'uneven/a/d', fromId: 'a', toId: 'd', units: 1}], 'fewest points tie: most senior owes');
  assert.deepEqual(unevenTransfers(ids, flat, {a: 8, b: 10, c: 10, d: 10}), [{id: 'uneven/a/b', fromId: 'a', toId: 'b', units: 1}], 'most points tie: most senior is owed');
  assert.deepEqual(unevenTransfers(ids, flat, {a: 8, b: 8, c: 11, d: 11}).map(u => `${u.fromId}>${u.toId}:${u.units}`), ['a>c:1', 'b>d:1']);
  assert.deepEqual(unevenTransfers(ids, flat, {a: 10, b: 10, c: 9, d: 9}), [], 'a remainder given to senior members is the same split: no debt');
  assert.deepEqual(unevenTransfers(ids, flat, {a: 7, b: 9, c: 9, d: 13}), [{id: 'uneven/a/d', fromId: 'a', toId: 'd', units: 2}, {id: 'uneven/b/d', fromId: 'b', toId: 'd', units: 1}], 'one creditor, two debtors, senior tie first');
});

test('uneven credit survives edits, protects the creditor\'s carried work from relief and cannot be forged by hand', () => {
  const i = holiday(), r = proposal(i);
  const e = edit(i, r.draft, 'e11', -2);
  assert.deepEqual(e.draft.uneven, r.draft.uneven); assert.equal(compiled(i, e.draft).confirmable, true);
  const dragged = transferAllocation(i, r.draft, {id: 'drag/0', fromId: 'e06', toId: 'e00', units: 2, kind: 'temporary'}).draft;
  assert.equal(compiled(i, dragged).confirmable, true);
  assert.throws(() => transferAllocation(i, r.draft, {id: 'uneven/e00/e07', fromId: 'e00', toId: 'e07', units: 2, kind: 'temporary'}), /invalid-transfer-identity/);
  const forged = structuredClone(r.draft); forged.uneven.push({id: 'uneven/e01/e11', fromId: 'e01', toId: 'e11', units: 20});
  assert.throws(() => compiled(i, forged), /uneven-credit-exceeds-share/);
  const foreign = structuredClone(r.draft); foreign.uneven[0] = {...foreign.uneven[0], id: 'manual/0'};
  assert.throws(() => compiled(i, foreign), /invalid-uneven-credit/);
  // An old creditor with uneven credit keeps that half point: relief stops at 4.5 of its 5 points.
  const owed = owe(holiday(), 'e00', 'e11', 20, 'old'), relief = proposal(owed);
  invariant(owed, relief);
  assert.equal(total(relief.draft.repayments.map(p => p.units)), 9);
  assert.equal(relief.draft.targetsUnits.e11, 1);
  assert.equal(compiled(owed, relief.draft).confirmable, true);
  const greedy = structuredClone(relief.draft), [plan] = greedy.repayments;
  plan.units = 10; plan.claim.units = 10; plan.claim.path[0].units = 10;
  greedy.offeredUnits.e00 += 1; greedy.offeredUnits.e11 -= 1; greedy.targetsUnits.e00 += 1; greedy.targetsUnits.e11 -= 1;
  assert.throws(() => compiled(owed, greedy), /repayment-exceeds-creditor-relief/, 'relief cannot consume work carried for the debtor');
});

test('uneven credit publishes as an ordinary temporary claim and a later half-point month repays it', async () => {
  const i = sixHoliday(), r = proposal(i), assignments = generated(i, r.draft);
  const bound = await bindAllocation(i, r.draft, assignments, {publicationId: 'november', sourceKey: 'publish/november', actor: 'manager'});
  assert.equal(bound.bindable, true); assert.equal(bound.publishable, true);
  assert.deepEqual(bound.publication.intents.flatMap(t => t.route.flatMap(l => l.counterparts)),
    [{id: 'uneven/e00/e03', fromId: 'e00', toId: 'e03', units: 1, kind: 'temporary'}], 'recorded with the ordinary counterpart shape and its uneven identity');
  for (const t of bound.publication.intents) for (const s of t.capacity) assert.equal(assignments[s.date].primary, t.toId);
  const published = record(i.events, {sourceKey: 'publish/november', actor: 'manager', at: i.now,
    operation: {kind: 'publication', month: '2026-11', beforeId: null, after: bound.publication}}).events;
  assert.deepEqual(project(published, i.now, i.now).actual.net, {e00: -1, e01: 0, e02: 0, e03: 1, e04: 0, e05: 0});
  // December has six +0.5 weekdays, so half-point duties exist and the month itself splits evenly.
  const next = {...structuredClone(i), events: published, now: Date.parse('2026-11-20T10:00:00Z')};
  next.schedule.month = '2026-12';
  next.schedule.calendar = {specials: [{id: 'a', start: '2026-12-07', end: '2026-12-11', extra: 0.5}, {id: 'b', start: '2026-12-13', end: '2026-12-15', extra: 0.5}]};
  const d = proposal(next); invariant(next, d);
  assert.deepEqual(d.draft.uneven, []);
  assert.deepEqual(d.draft.repayments.map(p => [p.claim.debtorId, p.claim.creditorId, p.units]), [['e00', 'e03', 1]]);
  assert.equal(d.draft.targetsUnits.e00, d.draft.baselineUnits.e00 + 1); assert.equal(d.draft.targetsUnits.e03, d.draft.baselineUnits.e03 - 1);
  const december = await bindAllocation(next, d.draft, generated(next, d.draft), {publicationId: 'december', sourceKey: 'publish/december', actor: 'manager'});
  assert.equal(december.publishable, true); assert.equal(december.publication.reservations.length, 1);
  const settled = record(published, {sourceKey: 'publish/december', actor: 'manager', at: next.now,
    operation: {kind: 'publication', month: '2026-12', beforeId: null, after: december.publication}}).events;
  const done = Date.parse('2027-01-05T10:00:00Z'), view = project(settled, done, done).actual;
  assert.deepEqual(view.claims, []);
  assert.deepEqual(view.net, {e00: 0, e01: 0, e02: 0, e03: 0, e04: 0, e05: 0}, 'repayment settles the uneven credit like any other temporary transfer');
});

test('repayment has no monthly cap beyond creditor relief and debtor availability', () => {
  const i = owe(scenario(), 'e11', 'e00', 8, 'old'), r = proposal(i);
  invariant(i, r);
  assert.equal(r.draft.baselineUnits.e00, 4, 'equal ordinary share; repayment never changes the baseline');
  assert.equal(total(r.draft.repayments.map(p => p.units)), 4, 'two points, bounded by the creditor share');
  assert.equal(r.draft.targetsUnits.e00, 0);
  assert.equal(r.draft.targetsUnits.e11, r.draft.baselineUnits.e11 + 4);
  assert.deepEqual(r.draft.offeredUnits, r.draft.targetsUnits);
  const p = compiled(i, r.draft).plan;
  assert.equal(total(p.repayments.map(r => r.units)), 4); assert.equal(total(p.deferred.map(r => r.units)), 4);
  assert.deepEqual(p.intents, []);
});

test('partial oldest repayment uses real half duties; a younger claim cannot take its capacity', () => {
  const i = owe(owe(scenario(), 'e00', 'e11', 4, 'old'), 'e00', 'e10', 2, 'young');
  i.schedule.calendar.splitWeekends = ['2026-11-06'];
  const allowed = ['2026-11-01', '2026-11-04', '2026-11-06', '2026-11-09'];
  i.schedule.constraints.e00 = Object.fromEntries(canonicalDuties(i.schedule.month, i.schedule.calendar)
    .flatMap(d => allowed.includes(d.id) ? [] : d.dates.map(date => [date, 'no'])));
  const r = proposal(i); invariant(i, r);
  assert.equal(allocationCeilings(i).e00, 7, 'three whole duties and one half duty');
  assert.deepEqual(r.draft.repayments.map(r => [r.claim.priority.lotId, r.units]), [['old', 3]]);
  assert.equal(r.draft.targetsUnits.e00, 7);
});

test('an older infeasible claim stays open while a feasible younger obligation progresses', () => {
  const i = owe(owe(scenario(), 'e00', 'e11', 4, 'old'), 'e01', 'e10', 2, 'young');
  i.schedule.constraints.e00 = Object.fromEntries(canonicalDuties(i.schedule.month, {}).flatMap(d =>
    ['2026-11-01', '2026-11-02', '2026-11-03'].includes(d.id) ? [] : d.dates.map(date => [date, 'no'])));
  const r = proposal(i); invariant(i, r);
  assert.equal(allocationCeilings(i).e00, 4, 'three back-to-back duties allow two');
  assert.deepEqual(r.draft.repayments.map(r => [r.claim.priority.lotId, r.units]), [['young', 2]]);
  assert.ok(compiled(i, r.draft).plan.deferred.some(p => p.claim.path[0].lotId === 'old' && p.units === 4));
});

test('half-point debt cannot split a whole-point duty or manufacture a rounding transfer', () => {
  const i = owe(scenario(), 'e00', 'e11', 1, 'half'), r = proposal(i);
  assert.deepEqual(r.draft.repayments, []); assert.deepEqual(r.draft.transfers, []);
  assert.equal(compiled(i, r.draft).plan.deferred[0].units, 1);
});

test('availability is a live ceiling, not an automatic change; the baseline remains fair', () => {
  const i = scenario();
  assert.ok(Object.values(allocationCeilings(i)).every(units => units >= 14), 'no back-to-back duties: about half the month');
  i.schedule.constraints.e00 = Object.fromEntries(canonicalDuties(i.schedule.month, {}).flatMap(d => d.dates.map(date => [date, 'no'])));
  const r = proposal(i); invariant(i, r);
  assert.equal(allocationCeilings(i).e00, 0);
  assert.equal(r.draft.baselineUnits.e00, 4); assert.equal(r.draft.targetsUnits.e00, 4, 'the manager moves it; the row warns');
  assert.deepEqual(r.draft.transfers, []);
  // A dragged relief point becomes explicit temporary intent.
  const moved = transferAllocation(i, r.draft, {id: 'relief/0', fromId: 'e00', toId: 'e09', units: 2, kind: 'temporary'}).draft;
  const p = compiled(i, moved).plan;
  assert.ok(p.intents.every(t => t.fromId === 'e00' && t.kind === 'temporary'));
});

test('temporary/permanent counterpart preferences and whole-request precedence', () => {
  const d = normal.draft, i = normalInput;
  const temp = edit(i, d, 'e11', -2);
  assert.deepEqual(temp.draft.transfers.map(t => [t.fromId, t.toId, t.units]), [['e11', 'e09', 2]]);
  const increase = edit(i, d, 'e00', 2, 'permanent');
  assert.equal(increase.draft.transfers[0].fromId, 'e10', 'highest target, senior tie');
  const decrease = edit(i, d, 'e00', -2, 'permanent');
  assert.equal(decrease.draft.transfers[0].toId, 'e09', 'lowest target, newest tie');
  const both = edit(i, increase.draft, 'e00', 2, 'temporary', 'temporary');
  const p = compiled(i, both.draft).plan;
  assert.equal(total(p.intents.filter(t => t.kind === 'permanent').map(t => t.units)), 2);
  assert.equal(total(p.intents.filter(t => t.kind === 'temporary').map(t => t.units)), 2);
  assert.deepEqual(normal.draft, d, 'original proposal not mutated');
});

test('automatic Target counterparts follow the baseline remainder order, not the next senior', () => {
  // 12 engineers, 26 points: 2 each, remainders to the newest (e10, e11 = 3).
  const d = normal.draft, i = normalInput;
  assert.deepEqual(Object.values(d.targetsUnits), [4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 6, 6]);
  const minus = edit(i, d, 'e00', -2);
  assert.deepEqual(minus.draft.transfers.map(t => [t.fromId, t.toId, t.units]), [['e00', 'e09', 2]], 'newest member at base receives');
  const plus = edit(i, d, 'e00', 2);
  assert.deepEqual(plus.draft.transfers.map(t => [t.fromId, t.toId, t.units]), [['e10', 'e00', 2]], 'most senior 3-point member gives');
});

test('half-point edits redistribute exactly; unplaceable edits stay pending and explicit controls consume them', () => {
  const i = normalInput, half = edit(i, normal.draft, 'e00', -1);
  assert.equal(half.balanced, true);
  assert.deepEqual(half.draft.transfers.map(t => [t.fromId, t.toId, t.units]), [['e00', 'e09', 1]]);
  // With every counterpart hand edited, the change waits for an explicit counterpart.
  const first = edit(i, {...normal.draft, handEdited: i.seniority.filter(id => id !== 'e00')}, 'e00', -1);
  assert.equal(first.balanced, false); assert.equal(first.draft.targetsUnits.e00, 3);
  assert.equal(first.draft.pending[0].deltaUnits, -1);
  assert.equal(compiled(i, first.draft, {}).confirmable, false);
  const undone = edit(i, first.draft, 'e00', 1, 'temporary', 'undo');
  assert.equal(undone.balanced, true); assert.deepEqual(undone.draft.targetsUnits, normal.draft.targetsUnits);
  assert.deepEqual(undone.draft.transfers, []); assert.deepEqual(undone.draft.pending, []);
  const second = edit(i, first.draft, 'e01', 1, 'temporary', 'finish');
  assert.equal(second.balanced, true); assert.deepEqual(second.draft.pending, []);
  assert.deepEqual(second.draft.transfers.map(t => [t.fromId, t.toId, t.units]), [['e00', 'e01', 1]]);
  const p = compiled(i, second.draft);
  assert.equal(p.check.feasibility, 'partial', 'whole-point duties cannot meet half targets; Generate keeps partial');
  assert.equal(p.confirmable, true);
});

test('automatic counterparts never move hand-edited members; protection survives edits', () => {
  // A=e01, B=e00, E=e04, F=e05. Unprotected, B's point would go back to A (now lowest).
  const i = normalInput, d = normal.draft, set = {...d.targetsUnits};
  let r = edit(i, d, 'e01', -2, 'temporary', 'a'); set.e01 -= 2;
  assert.deepEqual(r.draft.handEdited, ['e01']);
  r = edit(i, r.draft, 'e00', -2, 'temporary', 'b'); set.e00 -= 2;
  r = edit(i, r.draft, 'e04', 2, 'temporary', 'e'); set.e04 += 2;
  r = edit(i, r.draft, 'e05', 2, 'temporary', 'f'); set.e05 += 2;
  for (const id of ['e00', 'e01', 'e04', 'e05']) assert.equal(r.draft.targetsUnits[id], set[id], `${id} kept exactly as set`);
  assert.deepEqual([...r.draft.handEdited].sort(), ['e00', 'e01', 'e04', 'e05']);
  assert.equal(r.balanced, true); assert.deepEqual(r.draft.pending, []);
  const hand = new Set(r.draft.handEdited);
  assert.ok(r.draft.transfers.every(t => hand.has(t.fromId) !== hand.has(t.toId)), 'each automatic leg has one unprotected side');
  // e09/e08 absorbed A and B automatically and stay re-adjustable for E and F.
  assert.deepEqual(r.draft.transfers.map(t => [t.fromId, t.toId]), [['e01', 'e09'], ['e00', 'e08'], ['e08', 'e04'], ['e09', 'e05']]);
  assert.deepEqual(persistedDraft(r.draft), Object.fromEntries(Object.entries(r.draft).filter(([k]) => k !== 'handEdited')));
  assert.equal(compiled(i, r.draft).confirmable, true);
  assert.deepEqual(normal.draft.handEdited, undefined, 'a new proposal starts unprotected');
});

test('without an unprotected counterpart the requested edit stays pending, never undone', () => {
  const i = normalInput, ids = i.seniority;
  const draft = {...structuredClone(normal.draft), handEdited: ids.filter(id => id !== 'e00')};
  const r = edit(i, draft, 'e00', 2, 'temporary', 'solo');
  assert.equal(r.draft.targetsUnits.e00, normal.draft.targetsUnits.e00 + 2, 'requested edit kept');
  for (const id of ids.slice(1)) assert.equal(r.draft.targetsUnits[id], normal.draft.targetsUnits[id]);
  assert.deepEqual(r.draft.transfers, []); assert.equal(r.balanced, false);
  assert.equal(r.draft.pending[0].deltaUnits, 2);
  assert.throws(() => edit(i, {...normal.draft, handEdited: ['nobody']}, 'e00', 1), /invalid-hand-edits/);
});

test('a dragged transfer is exact, protects both members and can be made permanent', () => {
  const i = normalInput, d = normal.draft;
  const r = transferAllocation(i, d, {id: 'drag/0', fromId: 'e03', toId: 'e07', units: 2, kind: 'temporary'});
  assert.equal(r.balanced, true);
  assert.equal(r.draft.targetsUnits.e03, d.targetsUnits.e03 - 2); assert.equal(r.draft.targetsUnits.e07, d.targetsUnits.e07 + 2);
  assert.deepEqual(r.draft.transfers, [{id: 'drag/0', fromId: 'e03', toId: 'e07', units: 2, kind: 'temporary'}]);
  assert.deepEqual(r.draft.handEdited, ['e03', 'e07']);
  const temporary = compiled(i, r.draft).plan;
  assert.deepEqual(temporary.intents.map(t => [t.fromId, t.toId, t.kind]), [['e03', 'e07', 'temporary']], 'temporary creates linked compensation');
  const permanent = classifyTransfer(i, r.draft, 'drag/0', 'permanent');
  assert.deepEqual(permanent.targetsUnits, r.draft.targetsUnits); assert.equal(permanent.transfers[0].kind, 'permanent');
  assert.deepEqual(compiled(i, permanent).plan.intents.map(t => t.kind), ['permanent'], 'permanent creates no compensation claim');
  assert.equal(r.draft.transfers[0].kind, 'temporary', 'source draft not mutated');
  // Later automatic counterparts leave both dragged members alone.
  const later = edit(i, r.draft, 'e00', 2, 'temporary', 'later');
  assert.equal(later.draft.targetsUnits.e03, r.draft.targetsUnits.e03); assert.equal(later.draft.targetsUnits.e07, r.draft.targetsUnits.e07);
  assert.throws(() => transferAllocation(i, d, {id: 'x/0', fromId: 'e03', toId: 'e07', units: d.targetsUnits.e03 + 2, kind: 'temporary'}), /below-locked/);
  assert.throws(() => transferAllocation(i, r.draft, {id: 'drag/0', fromId: 'e03', toId: 'e07', units: 2, kind: 'temporary'}), /invalid-allocation-edit/);
  assert.throws(() => transferAllocation(i, d, {id: 'self/0', fromId: 'e03', toId: 'e03', units: 2, kind: 'temporary'}), /invalid-allocation-edit/);
  assert.throws(() => classifyTransfer(i, d, 'missing', 'permanent'), /invalid-allocation-edit/);
});

test('manual deferral reroutes through the creditor once, preserves source age and does not settle', () => {
  const i = owe(scenario(), 'e00', 'e11', 8, 'old'), before = structuredClone(i.events), r = proposal(i);
  // The creditor is hand edited, so the lowered debtor point reaches a third party.
  const changed = edit(i, {...r.draft, handEdited: ['e11']}, 'e00', -2), p = compiled(i, changed.draft).plan;
  assert.equal(total(p.repayments.map(p => p.units)), 4);
  assert.equal(total(p.deferred.map(p => p.units)), 4);
  assert.deepEqual(p.intents.map(t => [t.fromId, t.toId, t.units, t.kind]), [['e11', 'e09', 2, 'temporary']]);
  assert.equal(p.intents[0].deferredClaim.path[0].lotId, 'old');
  for (const repayment of p.repayments) for (const a of repayment.claim.path) {
    for (const intent of p.intents) for (const claim of intent.normalizedDeferredClaims ?? []) for (const b of claim.path) {
      assert.ok(a.lotId !== b.lotId || a.offset + a.units <= b.offset || b.offset + b.units <= a.offset,
        'rerouted source slices cannot also fund repayment');
    }
    for (const deferred of p.deferred) for (const b of deferred.claim.path) {
      assert.ok(a.lotId !== b.lotId || a.offset + a.units <= b.offset || b.offset + b.units <= a.offset);
    }
  }
  // Existing core independently checks the resulting debt network, without
  // creating both D->C and D->recipient for the same deferred work.
  let history = send(i.events, {kind: 'claim', debtorId: 'e11', creditorId: 'e09', units: 2}, 'approved-burden');
  history = send(history, {kind: 'adjust', mode: 'settle', claim: p.repayments[0].claim, units: 4}, 'completed-work');
  assert.deepEqual(replay(history).net, {e00: -4, e01: 0, e02: 0, e03: 0, e04: 0, e05: 0, e06: 0, e07: 0, e08: 0, e09: 2, e10: 0, e11: 2});
  assert.deepEqual(i.events, before);
  const permanent = compiled(i, edit(i, {...r.draft, handEdited: ['e11']}, 'e00', -2, 'permanent').draft).plan;
  assert.equal(total(permanent.repayments.map(p => p.units)), 4);
  assert.ok(permanent.intents.every(t => t.kind === 'permanent'));
});

test('counterpart chains collapse; returning repayment to debtor restores its original attribution', () => {
  const i = owe(scenario(), 'e00', 'e11', 6, 'old'), r = proposal(i), d = structuredClone(r.draft);
  d.transfers.push({id: 'out', fromId: 'e00', toId: 'e01', units: 2, kind: 'temporary'},
    {id: 'back', fromId: 'e01', toId: 'e00', units: 2, kind: 'temporary'});
  const p = compiled(i, d).plan;
  assert.equal(total(p.repayments.map(r => r.units)), 6); assert.deepEqual(p.intents, []);
});

test('final temporary workload repays existing reverse debt instead of netting it before completion', () => {
  const i = owe(scenario(), 'e00', 'e11', 8, 'old'), d = structuredClone(normal.draft);
  d.sourceKey = proposal(i).draft.sourceKey;
  d.transfers.push({id: 'reviewed', fromId: 'e11', toId: 'e00', units: 2, kind: 'temporary'});
  d.targetsUnits.e00 += 2; d.targetsUnits.e11 -= 2;
  const p = compiled(i, d).plan;
  assert.equal(total(p.repayments.map(r => r.units)), 2);
  assert.equal(total(p.deferred.map(r => r.units)), 6);
  assert.deepEqual(p.intents, []);
  assert.equal(replay(i.events).net.e00, -8, 'planned repayment is not earned settlement');
});

test('projection earns only through operational opening and excludes future reserved slices', () => {
  const i = owe(scenario(), 'e00', 'e11', 8, 'old'); i.now = Date.parse('2026-10-01T00:00Z');
  const claim = replay(i.events).claims[0];
  for (const [month, date, offset, id] of [['2026-10', '2026-10-29', 0, 'prior'], ['2026-12', '2026-12-01', 2, 'future']]) {
    i.events = send(i.events, {kind: 'publication', month, beforeId: null, after: {id, month,
      duties: [{startDate: date, endDate: date.slice(0, 8) + (Number(date.slice(8)) + 1).toString().padStart(2, '0'), primaryId: 'e00', units: 2}],
      intents: [], reservations: [{id, capacity: {date, offset: 0, units: 2}, claim: sliceClaim(claim, 2, offset)}]}}, id);
  }
  const before = structuredClone(i.events), r = proposal(i);
  assert.equal(r.projection.actual.net.e00, -8); assert.equal(r.projection.projected.net.e00, -6);
  assert.equal(total(r.projection.projected.candidates.map(c => c.units)), 4);
  assert.equal(total(r.draft.repayments.map(c => c.units)), 4);
  assert.ok(r.draft.repayments.every(c => c.claim.path[0].offset >= 4));
  assert.deepEqual(i.events, before);
});

test('locks are final floors, require classification above offered work, and cannot be donated', () => {
  const i = scenario();
  i.schedule.locks = ['2026-11-01', '2026-11-04', '2026-11-09', '2026-11-12'].map(dutyId => ({dutyId, engineer: 'e00'}));
  const r = proposal(i); invariant(i, r);
  assert.equal(r.draft.baselineUnits.e00, 4); assert.equal(r.draft.targetsUnits.e00, 8);
  assert.deepEqual(r.draft.transfers.map(t => [t.fromId, t.toId, t.units, t.kind]), [['e10', 'e00', 2, 'temporary'], ['e11', 'e00', 2, 'temporary']],
    'most points give first, most senior on ties');
  assert.throws(() => edit(i, r.draft, 'e00', -r.draft.targetsUnits.e00), /edit-below-locked-points/);
});

test('partial months retain all required nominal points; Generate keeps the partial result', () => {
  for (const kind of ['small-team', 'weighted', 'boundary']) {
    const i = scenario(kind), r = proposal(i); invariant(i, r);
    const p = compiled(i, r.draft);
    assert.equal(p.confirmable, true, kind);
    assert.equal(p.check.feasibility, kind === 'small-team' ? 'partial' : 'complete', kind);
    if (kind === 'small-team') assert.ok(total(Object.values(r.draft.targetsUnits)) > p.check.assignedUnits);
  }
});

test('partial compilation accounts only against the supplied feasibility witness', () => {
  const i = scenario();
  i.schedule.members = i.schedule.members.slice(0, 3); i.seniority = i.seniority.slice(0, 3);
  owe(i, 'e00', 'e02', 2, 'old');
  const r = proposal(i), assignments = generated(i, r.draft), p = compiled(i, r.draft, assignments); invariant(i, r);
  assert.equal(p.check.feasibility, 'partial');
  assert.deepEqual(p.check.assignments, assignments);
  assert.deepEqual(p.check.stages, []);
  assert.ok(total(p.plan.repayments.map(r => r.units)) <= p.check.actualUnits.e00);
});

test('confirmed targets remain verbatim; source changes invalidate drafts', () => {
  const before = structuredClone(normal.draft);
  edit(normalInput, freeze(structuredClone(before)), 'e00', -2);
  assert.deepEqual(normal.draft, before);
  const reordered = {...normalInput, seniority: [...normalInput.seniority].reverse()};
  assert.throws(() => edit(reordered, before, 'e00', -2), /stale-allocation/);
  for (const change of [
    i => i.schedule.sourceRevision += '-new',
    i => i.schedule.calendar.splitWeekends = ['2026-11-06'],
    i => i.schedule.constraints.e00 = {'2026-11-01': 'no'},
  ]) {const i = structuredClone(normalInput); change(i); assert.throws(() => compiled(i, before, {}), /stale-allocation/);}
  assert.throws(() => edit(normalInput, before, 'e00', 0.5), /invalid-allocation-edit/);
  assert.throws(() => proposal({...normalInput, seniority: ['e00']}), /invalid-allocation-seniority/);
});

test('duplicate/unexplained accounting slices are rejected', () => {
  const i = owe(scenario(), 'e00', 'e11', 4, 'old'), r = proposal(i), duplicate = structuredClone(r.draft);
  duplicate.repayments.push(structuredClone(duplicate.repayments[0]));
  assert.throws(() => compiled(i, duplicate, {}), /duplicate-repayment-source/);
  const edited = structuredClone(r.draft); edited.targetsUnits.e00++;
  assert.throws(() => compiled(i, edited, {}), /unexplained-target-edit/);
  const forged = structuredClone(r.draft); forged.repayments[0].claim.priority.at = 0;
  assert.throws(() => compiled(i, forged, {}), /invalid-repayment-source/);
  assert.equal(solver.activeModels, 0);
});
