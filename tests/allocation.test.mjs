import test from 'node:test';
import assert from 'node:assert/strict';
import loadHighs from 'highs';
import {createHighsAdapter, canonicalDuties, createGenerationRequest, solveGeneration} from '../lib/scheduling/index.ts';
import {record, replay, sliceClaim, project, loneHalf} from '../lib/compensation/index.ts';
import {reviewAllocation} from '../lib/allocation/review.ts';
import {proposeAllocation, allocationCeilings, editAllocation, compileAllocation, planAllocation, persistedDraft, transferAllocation, classifyTransfer,
  retainedChanges, deriveTransfers, balanced, unplacedChanges, nettedCompensation, bindAllocation, fitPartition, equalShares, unevenBaseline, unevenTransfers} from '../lib/allocation/index.ts';
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
const edit = (i, d, engineer, deltaUnits, kind = 'temporary') => editAllocation(i, d, {engineer, deltaUnits, kind});
const drag = (i, d, fromId, toId, units = 2, kind = 'temporary', id = `${fromId}>${toId}/${d.pairs.length}`) =>
  transferAllocation(i, d, {id, fromId, toId, units, kind});
const generated = (i, d) => solveGeneration(solver, createGenerationRequest({...i.schedule,
  targets: Object.fromEntries(Object.entries(d.targetsUnits).map(([k, v]) => [k, v / 2]))}, {now: i.now, seed: 17, seconds: 4})).assignments;
const compiled = (i, d, assignments = generated(i, d)) => compileAllocation(i, d, assignments);
const legs = d => d.transfers.map(t => [t.fromId, t.toId, t.units, t.kind]);
const changed = d => Object.fromEntries(Object.entries(d.changes).filter(([, c]) => c.temporary || c.permanent));
function invariant(i, r) {
  const duties = canonicalDuties(i.schedule.month, i.schedule.calendar), locked = {};
  for (const l of i.schedule.locks ?? []) locked[l.engineer] = (locked[l.engineer] ?? 0) + duties.find(d => d.id === l.dutyId).units;
  assert.equal(total(Object.values(r.draft.baselineUnits)), total(duties.map(d => d.units)));
  assert.equal(total(Object.values(r.draft.targetsUnits)), total(duties.map(d => d.units)));
  for (const [id, units] of Object.entries(r.draft.targetsUnits)) {
    assert.ok(units >= (locked[id] ?? 0), `${id} keeps its locked floor`);
    assert.equal(r.draft.offeredUnits[id] + r.draft.changes[id].temporary + r.draft.changes[id].permanent, units, `${id}: points = offered + changes`);
  }
  assert.ok(balanced(r.draft));
  assert.deepEqual(r.draft.transfers, deriveTransfers(i.seniority, r.draft.changes, r.draft.pairs), 'transfers are the derivation');
}
function freeze(v) {if (v && typeof v === 'object') {Object.values(v).forEach(freeze); Object.freeze(v);} return v;}

const normalInput = freeze(scenario()), normal = proposal(normalInput);

test('ordinary baseline uses exact attainable weights; saved seniority only breaks equivalent choices', () => {
  invariant(normalInput, normal);
  assert.deepEqual(proposal(normalInput), normal, 'deterministic');
  assert.deepEqual(Object.values(normal.draft.baselineUnits), [...Array(10).fill(4), 6, 6]);
  assert.deepEqual(normal.draft.transfers, []); assert.deepEqual(normal.draft.pairs, []);
  assert.ok(Object.values(normal.draft.changes).every(c => !c.temporary && !c.permanent));
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

const pair = (k, units = 1) => ({id: `uneven/e0${k}/e${String(k + 6).padStart(2, '0')}`, fromId: `e0${k}`, toId: `e${String(k + 6).padStart(2, '0')}`, units});
// Six members and seven +2 days: the only uneven month the solver covers completely.
const sixHoliday = () => {
  const i = scenario(); i.schedule.members = i.schedule.members.slice(0, 6); i.seniority = i.seniority.slice(0, 6);
  i.events = send([], {kind: 'members', members: i.schedule.members.map(m => ({id: m.id, active: true}))}, 'members');
  i.schedule.calendar = {specials: [{id: 'holiday', start: '2026-11-01', end: '2026-11-08', extra: 2}]}; return i;
};
const netted = (i, d) => {const p = planAllocation(i, d); return nettedCompensation({}, {transfers: p.plan.intents, repayments: p.plan.repayments}, i.seniority);};

test('an uneven month credits each extra half point from the fewest-points members to those above the equal share', () => {
  const i = holiday(), r = proposal(i);
  assert.deepEqual(r.draft.uneven, [0, 1, 2, 3, 4, 5].map(k => pair(k)), 'six most senior (4 pts) each owe one of the six newest (5 pts) half a point');
  assert.deepEqual(r.draft.targetsUnits, r.draft.baselineUnits, 'targets and the stored baseline are unchanged');
  assert.deepEqual(r.draft.transfers, [], 'the credit is not a change: nets stay zero');
  assert.deepEqual(normal.draft.uneven, [], 'a normal month creates no credit');
  assert.deepEqual(netted(i, r.draft), [0, 1, 2, 3, 4, 5].map(k => ({debtorId: `e0${k}`, creditorId: `e${String(k + 6).padStart(2, '0')}`, units: 1, thisMonth: 0, later: 1, reason: 'uneven'})));
  const six = sixHoliday(), s = proposal(six);
  assert.deepEqual(six.seniority.map(id => s.draft.baselineUnits[id]), [12, 13, 13, 14, 14, 14]);
  assert.deepEqual(s.draft.uneven, [{id: 'uneven/e00/e03', fromId: 'e00', toId: 'e03', units: 1}], 'the most senior 7-point member is owed by the 6-point member');
  assert.deepEqual(unevenBaseline(six, s.draft.baselineUnits), [{id: 'e03', units: 14}], 'the inline note names the same creditor');
  const p = compiled(six, s.draft);
  assert.equal(p.check.feasibility, 'complete'); assert.equal(p.confirmable, true);
  assert.deepEqual(p.plan.intents, [{fromId: 'e00', toId: 'e03', units: 1, kind: 'temporary', transferIds: ['uneven/e00/e03']}], 'publication intent: the creditor carries the debtor’s half point');
  assert.deepEqual(p.plan.funding.map(f => f.carrierId), ['e03']); assert.deepEqual(p.plan.repayments, []);
});

test('uneven credit ties: the remainder itself is never debt; equal points pick the most senior', () => {
  const flat = Array(38).fill(1), ids = ['a', 'b', 'c', 'd']; // plain split 9, 9, 10, 10
  assert.deepEqual(unevenTransfers(ids, flat, {a: 9, b: 9, c: 9, d: 11}), [{id: 'uneven/a/d', fromId: 'a', toId: 'd', units: 1}], 'fewest points tie: most senior owes');
  assert.deepEqual(unevenTransfers(ids, flat, {a: 8, b: 10, c: 10, d: 10}), [{id: 'uneven/a/b', fromId: 'a', toId: 'b', units: 1}], 'most points tie: most senior is owed');
  assert.deepEqual(unevenTransfers(ids, flat, {a: 8, b: 8, c: 11, d: 11}).map(u => `${u.fromId}>${u.toId}:${u.units}`), ['a>c:1', 'b>d:1']);
  assert.deepEqual(unevenTransfers(ids, flat, {a: 10, b: 10, c: 9, d: 9}), [], 'a remainder given to senior members is the same split: no debt');
  assert.deepEqual(unevenTransfers(ids, flat, {a: 7, b: 9, c: 9, d: 13}), [{id: 'uneven/a/d', fromId: 'a', toId: 'd', units: 2}, {id: 'uneven/b/d', fromId: 'b', toId: 'd', units: 1}], 'one creditor, two debtors, senior tie first');
  // Decision 2026-10-31: the credit follows the real permanent load.
  const change = (permanent, temporary = 0) => ({temporary, permanent}), base = {a: 8, b: 8, c: 11, d: 11};
  assert.deepEqual(unevenTransfers(ids, flat, base, {c: change(-1)}).map(u => u.id), ['uneven/a/d'], 'a creditor losing permanently is credited only for what it still carries');
  assert.deepEqual(unevenTransfers(ids, flat, base, {c: change(-5)}).map(u => u.id), ['uneven/a/d'], 'never below zero');
  assert.deepEqual(unevenTransfers(ids, flat, base, {a: change(1)}).map(u => u.id), ['uneven/b/c'], 'a debtor gaining permanently no longer sits below the split');
  assert.deepEqual(unevenTransfers(ids, flat, base, {c: change(2), a: change(-2)}).map(u => `${u.id}:${u.units}`), ['uneven/a/c:1', 'uneven/b/d:1'], 'permanent gains of a creditor and losses of a debtor are deliberate: no extra credit, no relief');
  assert.deepEqual(unevenTransfers(ids, flat, base, {c: change(0, -1), a: change(0, 1)}).map(u => u.id), ['uneven/a/c', 'uneven/b/d'], 'temporary changes carry their own compensation and leave the credit alone');
});

test('audit R3: a permanent reduction on an uneven creditor removes the credit instead of leaving fake debt', () => {
  const i = holiday(), r = proposal(i);
  // Permanent −0.5 on e11 (owed by e05) lands on e05, the newest 4-point member: both at 4.5 points.
  const d = edit(i, r.draft, 'e11', -1, 'permanent').draft;
  assert.deepEqual(legs(d), [['e11', 'e05', 1, 'permanent']]);
  assert.equal(d.targetsUnits.e05, 9); assert.equal(d.targetsUnits.e11, 9);
  assert.deepEqual(d.uneven, [0, 1, 2, 3, 4].map(k => pair(k)), 'e05 → e11 is gone; the other five credits stand');
  assert.ok(!netted(i, d).some(l => l.debtorId === 'e05' || l.creditorId === 'e11'), 'nothing is owed between two members at the equal share');
  assert.deepEqual(persistedDraft(d).uneven, d.uneven, 'the derived credit is persisted for the checked RPC');
  // A permanent gain on a debtor: the giver (most points, most senior: e06) and the debtor both leave the credit.
  const g = edit(i, r.draft, 'e05', 1, 'permanent').draft;
  assert.deepEqual(legs(g), [['e06', 'e05', 1, 'permanent']]);
  assert.deepEqual(g.uneven.map(u => u.id), ['uneven/e00/e07', 'uneven/e01/e08', 'uneven/e02/e09', 'uneven/e03/e10', 'uneven/e04/e11']);
  // A temporary reduction on a creditor is its own compensation: the pair nets to nothing, the credit itself stays.
  const t = edit(i, r.draft, 'e11', -1).draft;
  assert.deepEqual(legs(t), [['e11', 'e05', 1, 'temporary']]); assert.deepEqual(t.uneven, r.draft.uneven);
  assert.ok(!netted(i, t).some(l => l.debtorId === 'e05' || l.creditorId === 'e11'));
  // Undoing the permanent change restores the credit: it is a function of the state, never of the click history.
  assert.deepEqual(edit(i, d, 'e11', 1, 'permanent').draft.uneven, r.draft.uneven);
  assert.deepEqual(proposeAllocation(i, retainedChanges(d)).draft.uneven, d.uneven, 'a new proposal with the retained changes derives the same credit');
});

test('uneven credit survives edits, protects the creditor’s carried work from relief and cannot be forged by hand', () => {
  const i = holiday(), r = proposal(i);
  const e = edit(i, r.draft, 'e11', -2);
  assert.deepEqual(e.draft.uneven, r.draft.uneven); assert.equal(compiled(i, e.draft).confirmable, true);
  const dragged = drag(i, r.draft, 'e06', 'e00').draft;
  assert.deepEqual(dragged.uneven, r.draft.uneven); assert.equal(planAllocation(i, dragged).confirmable, true);
  const forged = structuredClone(r.draft); forged.uneven.push({id: 'uneven/e01/e11', fromId: 'e01', toId: 'e11', units: 20});
  assert.throws(() => planAllocation(i, forged), /uneven-credit-exceeds-share/);
  const foreign = structuredClone(r.draft); foreign.uneven[0] = {...foreign.uneven[0], id: 'manual/0'};
  assert.throws(() => planAllocation(i, foreign), /invalid-uneven-credit/);
  const duplicate = structuredClone(r.draft); duplicate.uneven.push({...duplicate.uneven[0]});
  assert.throws(() => planAllocation(i, duplicate), /invalid-uneven-credit/);
  // An old creditor with uneven credit keeps that half point: relief stops at 4.5 of its 5 points.
  const owed = owe(holiday(), 'e00', 'e11', 20, 'old'), relief = proposal(owed);
  invariant(owed, relief);
  assert.equal(total(relief.draft.repayments.map(p => p.units)), 9);
  assert.equal(relief.draft.targetsUnits.e11, 1);
  assert.equal(planAllocation(owed, relief.draft).confirmable, true);
  const greedy = structuredClone(relief.draft), [plan] = greedy.repayments;
  plan.units = 10; plan.claim.units = 10; plan.claim.path[0].units = 10;
  greedy.offeredUnits.e00 += 1; greedy.offeredUnits.e11 -= 1; greedy.targetsUnits.e00 += 1; greedy.targetsUnits.e11 -= 1;
  assert.throws(() => planAllocation(owed, greedy), /repayment-exceeds-creditor-relief/, 'relief cannot consume work carried for the debtor');
});

test('audit reorder: a seniority change after confirmation re-pairs the credit and keeps the confirmed baseline', () => {
  const i = holiday(), saved = persistedDraft(edit(i, proposal(i).draft, 'e03', -2).draft);
  const j = {...structuredClone(i), seniority: ['e11', ...i.seniority.slice(0, 11)]}; // the newest member becomes most senior
  // The retained draft still reviews: the credit is derived under the current order, the numbers are unchanged.
  const reviewed = reviewAllocation(j, saved);
  assert.deepEqual(reviewed.baselineUnits, saved.baselineUnits); assert.deepEqual(reviewed.targetsUnits, saved.targetsUnits);
  assert.deepEqual(reviewed.uneven.map(u => u.id), ['uneven/e00/e11', 'uneven/e01/e06', 'uneven/e02/e07', 'uneven/e03/e08', 'uneven/e04/e09', 'uneven/e05/e10']);
  assert.deepEqual(reviewed.uneven, unevenTransfers(j.seniority, weightsOf(j), saved.baselineUnits, saved.changes), 'exactly what the checked RPC derives');
  // A new proposal keeps the confirmed partition, so the database’s immutable-baseline rule still holds.
  const again = proposeAllocation(j, retainedChanges(saved)).draft;
  assert.deepEqual(again.baselineUnits, saved.baselineUnits); assert.deepEqual(again.uneven, reviewed.uneven);
  // A reopened draft treats every member with a nonzero change as hand edited.
  assert.deepEqual([...again.hand].sort(), Object.keys(saved.changes).filter(id => saved.changes[id].temporary || saved.changes[id].permanent).sort());
  assert.equal(again.targetsUnits.e03, saved.targetsUnits.e03);
  assert.notDeepEqual(proposeAllocation(j).draft.baselineUnits, saved.baselineUnits, 'without the retained baseline the larger shares would follow the new order');
  // A changed calendar is a new fit: the retained baseline no longer matches and is dropped.
  const k = structuredClone(j); k.schedule.calendar = {specials: [{id: 'holiday', start: '2026-11-01', end: '2026-11-08', extra: 2}]};
  assert.deepEqual(proposeAllocation(k, retainedChanges(saved)).draft.baselineUnits, proposeAllocation(k).draft.baselineUnits);
  // A normal month’s remainder follows the order, but the note never calls it uneven.
  const n = {...normalInput, seniority: ['e11', ...normalInput.seniority.slice(0, 11)]};
  assert.deepEqual(unevenBaseline(n, normal.draft.baselineUnits), []);
  assert.deepEqual(proposeAllocation(n, retainedChanges(normal.draft)).draft.baselineUnits, normal.draft.baselineUnits);
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

test('half-point debt cannot split a whole-point duty or manufacture a rounding transfer; a lone half waits and chains', () => {
  const i = owe(scenario(), 'e00', 'e11', 1, 'half'), r = proposal(i);
  assert.deepEqual(r.draft.repayments, []); assert.deepEqual(r.draft.transfers, []);
  assert.equal(compiled(i, r.draft).plan.deferred[0].units, 1);
  // The lone half carries forward in full and is shown waiting for its second half, never as repaid this month.
  // Shown as the popup shows it: from the projected net at month opening plus the compiled plan.
  const shown = (i, r) => {const p = planAllocation(i, r.draft); return nettedCompensation(r.projection.projected.net, {transfers: p.plan.intents, repayments: p.plan.repayments}, i.seniority);};
  assert.deepEqual(shown(i, r).map(l => [l.debtorId, l.creditorId, l.units, l.thisMonth, loneHalf(l.later)]), [['e00', 'e11', 1, 0, 1]]);
  // A half the creditor owes onward nets across people: e00 owes e05, e11 is clear, and nothing is rounded away.
  owe(i, 'e11', 'e05', 1, 'onward');
  const q = proposal(i); invariant(i, q);
  assert.deepEqual(q.draft.repayments, []);
  assert.deepEqual(project(i.events, i.now, i.now).actual.claims.map(c => [c.debtorId, c.creditorId, c.units, c.path.map(s => s.lotId)]),
    [['e00', 'e05', 1, ['half', 'onward']]], 'the ledger itself holds the chained half');
  assert.deepEqual(shown(i, q).map(l => [l.debtorId, l.creditorId, l.units, l.thisMonth, l.later]), [['e00', 'e05', 1, 0, 1]]);
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
  const moved = drag(i, r.draft, 'e00', 'e09').draft;
  const p = compiled(i, moved).plan;
  assert.ok(p.intents.every(t => t.fromId === 'e00' && t.kind === 'temporary'));
});

test('automatic counterparts: receivers fewest points newest first, givers most points senior first, one member per kind', () => {
  const d = normal.draft, i = normalInput;
  const temp = edit(i, d, 'e11', -2);
  assert.deepEqual(legs(temp.draft), [['e11', 'e09', 2, 'temporary']]);
  const increase = edit(i, d, 'e00', 2, 'permanent');
  assert.deepEqual(legs(increase.draft), [['e10', 'e00', 2, 'permanent']], 'highest points, senior tie');
  const decrease = edit(i, d, 'e00', -2, 'permanent');
  assert.deepEqual(legs(decrease.draft), [['e00', 'e09', 2, 'permanent']], 'lowest points, newest tie');
  const both = edit(i, increase.draft, 'e00', 2, 'temporary');
  assert.deepEqual(both.draft.changes.e00, {temporary: 2, permanent: 2});
  assert.deepEqual(legs(both.draft), [['e10', 'e00', 2, 'permanent'], ['e11', 'e00', 2, 'temporary']], 'the temporary giver skips the member already balancing permanent');
  const p = compiled(i, both.draft).plan;
  assert.equal(total(p.intents.filter(t => t.kind === 'permanent').map(t => t.units)), 2);
  assert.equal(total(p.intents.filter(t => t.kind === 'temporary').map(t => t.units)), 2);
  assert.deepEqual(normal.draft, d, 'original proposal not mutated');
});

test('automatic Temporary counterparts follow the baseline remainder order, not the next senior', () => {
  // 12 engineers, 26 points: 2 each, remainders to the newest (e10, e11 = 3).
  const d = normal.draft, i = normalInput;
  assert.deepEqual(Object.values(d.targetsUnits), [4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 6, 6]);
  const minus = edit(i, d, 'e00', -2);
  assert.deepEqual(legs(minus.draft), [['e00', 'e09', 2, 'temporary']], 'newest member at base receives');
  const plus = edit(i, d, 'e00', 2);
  assert.deepEqual(legs(plus.draft), [['e10', 'e00', 2, 'temporary']], 'most senior 3-point member gives');
});

test('the automatic balance is recomputed from scratch: order independent, never sticking on a hand-edited member', () => {
  // Decided example: − senior (temporary), then + Tamar (permanent, e09) gives senior 1, Tamar 3,
  // the senior's automatic point to the next newest and Tamar's point from the most senior untouched member.
  const i = normalInput, p = normal.draft;
  const a = edit(i, edit(i, p, 'e00', -2).draft, 'e09', 2, 'permanent').draft;
  const b = edit(i, edit(i, p, 'e09', 2, 'permanent').draft, 'e00', -2).draft;
  assert.deepEqual(a.targetsUnits, b.targetsUnits); assert.deepEqual(a.changes, b.changes); assert.deepEqual(a.transfers, b.transfers);
  assert.equal(a.targetsUnits.e00, 2); assert.equal(a.targetsUnits.e09, 6);
  assert.deepEqual(changed(a), {e00: {temporary: -2, permanent: 0}, e08: {temporary: 2, permanent: 0},
    e09: {temporary: 0, permanent: 2}, e10: {temporary: 0, permanent: -2}});
  assert.deepEqual(legs(a), [['e10', 'e09', 2, 'permanent'], ['e00', 'e08', 2, 'temporary']]);
  assert.deepEqual([...a.hand].sort(), ['e00', 'e09']);
  // A minus on a member who holds only an automatic point removes it; the point moves on.
  const held = edit(i, p, 'e00', -2).draft;
  assert.equal(held.targetsUnits.e09, 6);
  const removed = edit(i, held, 'e09', -2).draft;
  assert.equal(removed.targetsUnits.e09, 4); assert.equal(removed.targetsUnits.e08, 6);
  assert.deepEqual(removed.changes.e09, {temporary: 0, permanent: 0}); assert.ok(removed.hand.includes('e09'));
  // Hand changes never cancel each other implicitly: a minus elsewhere is a second intent.
  const two = edit(i, held, 'e01', -2).draft;
  assert.equal(two.targetsUnits.e00, 2); assert.equal(two.targetsUnits.e01, 2);
  assert.deepEqual([two.targetsUnits.e09, two.targetsUnits.e08], [6, 6], 'placed in duty steps, ranking refreshed');
  // The same per-person state reached through different clicks gives the same table.
  const ids = i.seniority; let seed = 3; const next = k => (seed = (seed * 1103515245 + 12345) % 2147483648) % k;
  for (let s = 0; s < 12; s++) {
    const edits = Array.from({length: 5}, () => ({engineer: ids[next(12)], deltaUnits: [-2, 2, -1, 1][next(4)], kind: next(2) ? 'temporary' : 'permanent'}));
    let x = p; for (const e of edits) {try {x = edit(i, x, e.engineer, e.deltaUnits, e.kind).draft;} catch {}}
    const hand = Object.fromEntries(x.hand.map(id => [id, x.changes[id]]));
    const members = [...x.hand].sort(() => next(2) - .5);
    let y = p;
    for (const id of members) for (const kind of ['temporary', 'permanent']) {
      const delta = hand[id][kind] - y.changes[id][kind];
      if (delta) y = edit(i, y, id, delta, kind).draft;
      else if (!y.hand?.includes(id)) y = edit(i, edit(i, y, id, 2, kind).draft, id, -2, kind).draft;
    }
    assert.deepEqual(y.targetsUnits, x.targetsUnits, `sequence ${s}`); assert.deepEqual(y.transfers, x.transfers);
  }
});

test('half-point changes redistribute exactly; a change without a counterpart stays visible and blocks compilation', () => {
  const i = normalInput, half = edit(i, normal.draft, 'e00', -1);
  assert.equal(half.balanced, true);
  assert.deepEqual(legs(half.draft), [['e00', 'e09', 1, 'temporary']]);
  // With every other member hand edited, the change waits for an explicit counterpart.
  const first = edit(i, {...normal.draft, hand: i.seniority.filter(id => id !== 'e00')}, 'e00', -1);
  assert.equal(first.balanced, false); assert.equal(first.draft.targetsUnits.e00, 3);
  assert.deepEqual(first.unplaced, {temporary: 1, permanent: 0}); assert.deepEqual(unplacedChanges(first.draft), first.unplaced);
  assert.deepEqual(first.draft.transfers, []);
  assert.equal(compiled(i, first.draft, {}).confirmable, false);
  assert.equal(compiled(i, first.draft, {}).diagnostics[0].code, 'unbalanced-allocation-changes');
  const undone = edit(i, first.draft, 'e00', 1);
  assert.equal(undone.balanced, true); assert.deepEqual(undone.draft.targetsUnits, normal.draft.targetsUnits);
  assert.deepEqual(undone.draft.transfers, []);
  const second = edit(i, first.draft, 'e01', 1);
  assert.equal(second.balanced, true);
  assert.deepEqual(legs(second.draft), [['e00', 'e01', 1, 'temporary']]);
  const p = compiled(i, second.draft);
  assert.equal(p.check.feasibility, 'partial', 'whole-point duties cannot meet half targets; Generate keeps partial');
  assert.equal(p.confirmable, true);
});

test('hand-edited members keep their points exactly; automatic points move on to untouched members', () => {
  const i = normalInput, d = normal.draft, set = {...d.targetsUnits};
  let r = edit(i, d, 'e01', -2); set.e01 -= 2;
  assert.deepEqual(r.draft.hand, ['e01']);
  r = edit(i, r.draft, 'e00', -2); set.e00 -= 2;
  assert.deepEqual([r.draft.targetsUnits.e09, r.draft.targetsUnits.e08], [6, 6], 'two automatic points on the newest base members');
  r = edit(i, r.draft, 'e04', 2); set.e04 += 2;
  r = edit(i, r.draft, 'e05', 2); set.e05 += 2;
  for (const id of ['e00', 'e01', 'e04', 'e05']) assert.equal(r.draft.targetsUnits[id], set[id], `${id} kept exactly as set`);
  assert.deepEqual([...r.draft.hand].sort(), ['e00', 'e01', 'e04', 'e05']);
  assert.deepEqual([r.draft.targetsUnits.e09, r.draft.targetsUnits.e08], [4, 4], 'the automatic points are no longer needed');
  assert.equal(r.balanced, true);
  assert.deepEqual(legs(r.draft), [['e00', 'e04', 2, 'temporary'], ['e01', 'e05', 2, 'temporary']], 'netted largest first, then seniority');
  assert.deepEqual(persistedDraft(r.draft), Object.fromEntries(Object.entries(r.draft).filter(([k]) => k !== 'hand')));
  assert.equal(compiled(i, r.draft).confirmable, true);
  assert.deepEqual(normal.draft.hand, undefined, 'a new proposal starts unprotected');
});

test('without an untouched counterpart the requested change stays, visibly unplaced', () => {
  const i = normalInput, ids = i.seniority;
  const draft = {...structuredClone(normal.draft), hand: ids.filter(id => id !== 'e00')};
  const r = edit(i, draft, 'e00', 2);
  assert.equal(r.draft.targetsUnits.e00, normal.draft.targetsUnits.e00 + 2, 'requested change kept');
  for (const id of ids.slice(1)) assert.equal(r.draft.targetsUnits[id], normal.draft.targetsUnits[id]);
  assert.deepEqual(r.draft.transfers, []); assert.equal(r.balanced, false);
  assert.deepEqual(r.unplaced, {temporary: -2, permanent: 0});
  assert.throws(() => edit(i, {...normal.draft, hand: ['nobody']}, 'e00', 1), /invalid-hand-edits/);
});

test('a dragged point is an explicit pair: exact, protecting both members, routing derived debt and switchable to permanent', () => {
  const i = normalInput, d = normal.draft;
  const r = drag(i, d, 'e03', 'e07');
  assert.equal(r.balanced, true);
  assert.equal(r.draft.targetsUnits.e03, d.targetsUnits.e03 - 2); assert.equal(r.draft.targetsUnits.e07, d.targetsUnits.e07 + 2);
  assert.deepEqual(r.draft.pairs, [{id: 'e03>e07/0', fromId: 'e03', toId: 'e07', units: 2, kind: 'temporary'}]);
  assert.deepEqual(r.draft.transfers, [{id: 'temporary/e03/e07', fromId: 'e03', toId: 'e07', units: 2, kind: 'temporary'}]);
  assert.deepEqual(r.draft.hand, ['e03', 'e07']);
  const temporary = compiled(i, r.draft).plan;
  assert.deepEqual(temporary.intents.map(t => [t.fromId, t.toId, t.kind]), [['e03', 'e07', 'temporary']], 'temporary creates linked compensation');
  const permanent = classifyTransfer(i, r.draft, 'e03>e07/0', 'permanent');
  assert.deepEqual(permanent.targetsUnits, r.draft.targetsUnits); assert.equal(permanent.transfers[0].kind, 'permanent');
  assert.deepEqual(changed(permanent), {e03: {temporary: 0, permanent: -2}, e07: {temporary: 0, permanent: 2}});
  assert.deepEqual(compiled(i, permanent).plan.intents.map(t => t.kind), ['permanent'], 'permanent creates no compensation claim');
  assert.equal(r.draft.transfers[0].kind, 'temporary', 'source draft not mutated');
  // Later automatic counterparts leave both dragged members alone.
  const later = edit(i, r.draft, 'e00', 2);
  assert.equal(later.draft.targetsUnits.e03, r.draft.targetsUnits.e03); assert.equal(later.draft.targetsUnits.e07, r.draft.targetsUnits.e07);
  // A plus on the giver afterwards keeps the receiver's point: the pair is clipped and someone else gives.
  const back = edit(i, r.draft, 'e03', 2).draft;
  assert.equal(back.targetsUnits.e03, d.targetsUnits.e03); assert.equal(back.targetsUnits.e07, d.targetsUnits.e07 + 2);
  assert.deepEqual(legs(back), [['e10', 'e07', 2, 'temporary']]);
  // Two drags between the same members merge into one derived transfer; opposite drags cancel.
  const twice = drag(i, r.draft, 'e03', 'e07').draft;
  assert.deepEqual(legs(twice), [['e03', 'e07', 4, 'temporary']]); assert.equal(twice.pairs.length, 2);
  const cancelled = drag(i, r.draft, 'e07', 'e03').draft;
  assert.deepEqual(cancelled.transfers, []); assert.deepEqual(cancelled.targetsUnits, d.targetsUnits);
  assert.throws(() => drag(i, d, 'e03', 'e07', d.targetsUnits.e03 + 2), /below-locked/);
  assert.throws(() => transferAllocation(i, r.draft, {id: 'e03>e07/0', fromId: 'e03', toId: 'e07', units: 2, kind: 'temporary'}), /invalid-allocation-edit/);
  assert.throws(() => drag(i, d, 'e03', 'e03'), /invalid-allocation-edit/);
  assert.throws(() => classifyTransfer(i, d, 'missing', 'permanent'), /invalid-allocation-edit/);
});

test('floors: fair + Permanent and planned relief are never taken away permanently; points never go below locked', () => {
  const i = normalInput, d = normal.draft;
  const atFloor = edit(i, d, 'e00', -4, 'permanent').draft;
  assert.equal(atFloor.targetsUnits.e00, 0);
  assert.throws(() => edit(i, atFloor, 'e00', -2, 'permanent'), /permanent-below-fair-share/);
  // Opposite clicks of the same kind reduce that kind first; temporary credit never unlocks more permanent reduction.
  const credited = edit(i, atFloor, 'e00', 2).draft;
  assert.deepEqual(credited.changes.e00, {temporary: 2, permanent: -4});
  assert.throws(() => edit(i, credited, 'e00', -2, 'permanent'), /permanent-below-fair-share/);
  assert.deepEqual(edit(i, credited, 'e00', 2, 'permanent').draft.changes.e00, {temporary: 2, permanent: -2});
  assert.throws(() => drag(i, atFloor, 'e00', 'e01', 2, 'permanent'), /permanent-below-fair-share/);
  // A creditor relieved by planned repayment cannot give that relief away permanently.
  const j = owe(scenario(), 'e00', 'e11', 8, 'old'), r = proposal(j);
  assert.equal(r.draft.offeredUnits.e11, 0, 'fully relieved this month');
  assert.throws(() => edit(j, r.draft, 'e11', -2, 'permanent'), /permanent-below-fair-share|edit-below-locked-points/);
  const extra = edit(j, r.draft, 'e11', 2).draft;
  assert.throws(() => edit(j, extra, 'e11', -2, 'permanent'), /permanent-below-fair-share/);
  assert.throws(() => edit(j, r.draft, 'e11', -2), /edit-below-locked-points/);
});

test('a temporary change on a debtor defers newest repayment; a permanent change that keeps the points never consumes it', () => {
  const i = owe(scenario(), 'e00', 'e11', 8, 'old'), r = proposal(i);
  assert.equal(r.draft.offeredUnits.e00, 10); assert.equal(total(r.draft.repayments.map(p => p.units)), 6);
  const lowered = drag(i, r.draft, 'e00', 'e09', 2, 'permanent').draft, p = compiled(i, lowered).plan;
  assert.equal(total(p.repayments.map(p => p.units)), 4, 'lowered by one point: the newest point of repayment is deferred');
  assert.equal(total(p.deferred.map(p => p.units)), 4);
  const kept = edit(i, edit(i, r.draft, 'e00', -2, 'permanent').draft, 'e00', 2).draft;
  assert.equal(kept.targetsUnits.e00, 10);
  const q = compiled(i, kept).plan;
  assert.equal(total(q.repayments.map(p => p.units)), 6, 'same points: all planned repayment stays');
  assert.deepEqual(q.intents.map(t => [t.fromId, t.toId, t.kind]).sort(), [['e00', 'e11', 'permanent'], ['e10', 'e00', 'temporary']]);
  // The netted list reads the compiled plan: what is really repaid now and later.
  const planned = planAllocation(i, lowered);
  assert.equal(planned.confirmable, true);
  const lines = nettedCompensation(r.projection.projected.net, {transfers: planned.plan.intents, repayments: planned.plan.repayments}, i.seniority);
  assert.deepEqual(lines, [{debtorId: 'e00', creditorId: 'e11', units: 8, thisMonth: 4, later: 4}]);
});

test('manual deferral reroutes through the creditor once, preserves source age and does not settle', () => {
  const i = owe(scenario(), 'e00', 'e11', 8, 'old'), before = structuredClone(i.events), r = proposal(i);
  // The creditor is hand edited, so the lowered debtor point reaches a third party.
  const changedDraft = edit(i, {...r.draft, hand: ['e11']}, 'e00', -2), p = compiled(i, changedDraft.draft).plan;
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
  const permanent = compiled(i, edit(i, {...r.draft, hand: ['e11']}, 'e00', -2, 'permanent').draft).plan;
  assert.equal(total(permanent.repayments.map(p => p.units)), 4);
  assert.ok(permanent.intents.every(t => t.kind === 'permanent'));
});

test('round trips cancel in the nets; mixed-kind round trips bind as two separate routes', async () => {
  const i = owe(scenario(), 'e00', 'e11', 6, 'old'), r = proposal(i);
  const out = drag(i, r.draft, 'e00', 'e01').draft, back = drag(i, out, 'e01', 'e00').draft;
  assert.deepEqual(back.transfers, []); assert.deepEqual(back.targetsUnits, r.draft.targetsUnits);
  const p = compiled(i, back).plan;
  assert.equal(total(p.repayments.map(r => r.units)), 6); assert.deepEqual(p.intents, []);
  // Audit case: A→B temporary, B→C twice, B→A made permanent. Confirm and Publish agree.
  const j = normalInput;
  let e = drag(j, normal.draft, 'e03', 'e07').draft; e = drag(j, e, 'e07', 'e05').draft; e = drag(j, e, 'e07', 'e05').draft; e = drag(j, e, 'e07', 'e03').draft;
  e = classifyTransfer(j, e, e.pairs.at(-1).id, 'permanent');
  assert.deepEqual(changed(e), {e03: {temporary: -2, permanent: 2}, e05: {temporary: 4, permanent: 0}, e07: {temporary: -2, permanent: -2}});
  const bound = await bindAllocation(j, e, generated(j, e), {publicationId: 'p', sourceKey: 'publish/p', actor: 'm'});
  assert.equal(bound.bindable, true); assert.equal(bound.publishable, true);
  assert.ok(bound.publication.intents.every(t => t.route.length === 1), 'no chained route through a round trip');
});

test('final temporary workload repays existing reverse debt instead of netting it before completion', () => {
  const i = owe(scenario(), 'e00', 'e11', 8, 'old'), base = proposal(i).draft;
  // Without planned repayment this month, the creditor's dragged point is repayment work.
  const d = {...structuredClone(base), repayments: [], offeredUnits: {...base.baselineUnits}, targetsUnits: {...base.baselineUnits}};
  const r = drag(i, d, 'e11', 'e00').draft, p = compiled(i, r).plan;
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

test('locks are final floors, topped up temporarily from the members with most points, and cannot be donated', () => {
  const i = scenario();
  i.schedule.locks = ['2026-11-01', '2026-11-04', '2026-11-09', '2026-11-12'].map(dutyId => ({dutyId, engineer: 'e00'}));
  const r = proposal(i); invariant(i, r);
  assert.equal(r.draft.baselineUnits.e00, 4); assert.equal(r.draft.targetsUnits.e00, 8);
  assert.deepEqual(changed(r.draft), {e00: {temporary: 4, permanent: 0}, e10: {temporary: -2, permanent: 0}, e11: {temporary: -2, permanent: 0}});
  assert.deepEqual(legs(r.draft), [['e10', 'e00', 2, 'temporary'], ['e11', 'e00', 2, 'temporary']], 'most points give first, most senior on ties');
  assert.throws(() => edit(i, r.draft, 'e00', -r.draft.targetsUnits.e00), /edit-below-locked-points/);
  // The top-up survives other edits and never moves a hand-edited member.
  const later = edit(i, r.draft, 'e10', 2).draft;
  assert.equal(later.targetsUnits.e00, 8); assert.equal(later.targetsUnits.e10, 6);
});

test('a new proposal keeps the per-person changes of members still present when they fit', () => {
  const i = normalInput, x = drag(i, edit(i, normal.draft, 'e00', -2).draft, 'e03', 'e07').draft;
  const again = proposeAllocation(i, retainedChanges(x)).draft;
  assert.deepEqual(again.targetsUnits, x.targetsUnits); assert.deepEqual(again.pairs, x.pairs); assert.deepEqual(again.transfers, x.transfers);
  assert.deepEqual([...again.hand].sort(), ['e00', 'e03', 'e07']);
  const j = {...structuredClone(normalInput), seniority: normalInput.seniority.filter(id => id !== 'e07')};
  j.schedule.members = j.schedule.members.filter(m => m.id !== 'e07');
  const fewer = proposeAllocation(j, retainedChanges(x)).draft;
  assert.equal(fewer.changes.e00.temporary, -2); assert.deepEqual(fewer.pairs, []); assert.deepEqual([...fewer.hand].sort(), ['e00', 'e03']);
  assert.equal(retainedChanges(null), undefined);
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

test('the transfer list is derived, never chosen: pairs first, then netting, one transfer per direction', () => {
  const order = ['a', 'b', 'c', 'd'], change = (t, p = 0) => ({temporary: t, permanent: p});
  const derive = (changes, pairs = []) => deriveTransfers(order, changes, pairs).map(t => [t.id, t.units]);
  assert.deepEqual(derive({a: change(-4), b: change(-2), c: change(2), d: change(4)}), [['temporary/a/d', 4], ['temporary/b/c', 2]], 'largest first');
  assert.deepEqual(derive({a: change(-2), b: change(-2), c: change(2), d: change(2)}), [['temporary/a/c', 2], ['temporary/b/d', 2]], 'then seniority order');
  assert.deepEqual(derive({a: change(-2), b: change(-2), c: change(2), d: change(2)}, [{id: 'p', fromId: 'a', toId: 'd', units: 2, kind: 'temporary'}]),
    [['temporary/a/d', 2], ['temporary/b/c', 2]], 'an explicit pair routes first');
  assert.deepEqual(derive({a: change(-2), d: change(2)}, [{id: 'p', fromId: 'a', toId: 'd', units: 6, kind: 'temporary'}]), [['temporary/a/d', 2]], 'clipped to the nets');
  assert.deepEqual(derive({a: change(2), d: change(-2)}, [{id: 'p', fromId: 'a', toId: 'd', units: 2, kind: 'temporary'}]), [['temporary/d/a', 2]], 'a pair against the nets is ignored');
  assert.deepEqual(derive({a: change(-2, -2), b: change(2, 2)}), [['permanent/a/b', 2], ['temporary/a/b', 2]], 'permanent first');
  assert.deepEqual(derive({a: change(0), b: change(0)}, [{id: 'x', fromId: 'a', toId: 'b', units: 2, kind: 'temporary'}, {id: 'y', fromId: 'b', toId: 'a', units: 2, kind: 'temporary'}]), [], 'round trips cancel');
  const unexplained = structuredClone(normal.draft); unexplained.transfers.push({id: 'temporary/e00/e01', fromId: 'e00', toId: 'e01', units: 2, kind: 'temporary'});
  assert.throws(() => compiled(normalInput, unexplained, {}), /invalid-derived-transfers/);
});

test('duplicate/unexplained accounting slices are rejected', () => {
  const i = owe(scenario(), 'e00', 'e11', 4, 'old'), r = proposal(i), duplicate = structuredClone(r.draft);
  duplicate.repayments.push(structuredClone(duplicate.repayments[0]));
  assert.throws(() => compiled(i, duplicate, {}), /duplicate-repayment-source/);
  const edited = structuredClone(r.draft); edited.targetsUnits.e00++;
  assert.throws(() => compiled(i, edited, {}), /unexplained-target-edit/);
  const forged = structuredClone(r.draft); forged.repayments[0].claim.priority.at = 0;
  assert.throws(() => compiled(i, forged, {}), /invalid-repayment-source/);
  // e11 is relieved by 4 of its 6 units: a permanent reduction of 4 would take relief away.
  const below = structuredClone(r.draft); below.changes.e11 = {temporary: 2, permanent: -4}; below.changes.e00 = {temporary: -2, permanent: 4};
  below.targetsUnits.e11 -= 2; below.targetsUnits.e00 += 2; below.transfers = deriveTransfers(i.seniority, below.changes, []);
  assert.throws(() => compiled(i, below, {}), /permanent-below-fair-share/);
  assert.equal(solver.activeModels, 0);
});
