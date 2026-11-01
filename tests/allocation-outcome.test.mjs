import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalDuties} from '../lib/scheduling/calendar.ts';
import {generatedNotes} from '../lib/allocation/outcome.ts';

const schedule = {month: '2026-11', calendar: {}, members: [], constraints: {}};
const input = (approvals = []) => ({schedule: {...schedule, approvals}, seniority: [], events: [], now: 0});
const duties = canonicalDuties('2026-11', {});

test('plan notes count back-to-back days per member; an approved fixed pair is not one', () => {
  const assignments = Object.fromEntries(duties.map(d => [d.id, {primary: null}]));
  assert.deepEqual(generatedNotes(input(), assignments), {generated: false, backToBack: {}});
  // Three days in a row count three; a lone duty and a day apart count nothing.
  for (const id of ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-05']) assignments[id] = {primary: 'a'};
  for (const id of ['2026-11-09', '2026-11-11']) assignments[id] = {primary: 'b'};
  // Thursday into the combined weekend touches; the weekend into Sunday does too.
  for (const id of ['2026-11-12', '2026-11-13', '2026-11-15']) assignments[id] = {primary: 'c'};
  assert.deepEqual(generatedNotes(input(), assignments), {generated: true, backToBack: {a: 3, c: 3}});
  const approved = [{rule: 'consecutive', duties: ['2026-11-01', '2026-11-02'], reason: 'Reviewed'}];
  assert.deepEqual(generatedNotes(input(approved), assignments).backToBack, {a: 2, c: 3});
});

import loadHighs from 'highs';
import {createHighsAdapter, createGenerationRequest, solveGeneration} from '../lib/scheduling/index.ts';
import {record, project, sliceClaim} from '../lib/compensation/index.ts';
import {proposeAllocation, transferAllocation, editAllocation, compileAllocation, planAllocation, bindAllocation, persistedDraft} from '../lib/allocation/index.ts';
import {reviewAllocation} from '../lib/allocation/review.ts';
import {monthScenario} from './fixtures/generation.mjs';

const send = (h, operation, sourceKey, at = (h.at(-1)?.at ?? 0) + 1) => record(h,
  {operation, sourceKey, at, actor: 'manager', reason: 'Reviewed fixture'}).events;
const solver = await createHighsAdapter(loadHighs);
/** A published month left everyone owing e00; e10's debt is the oldest, so the plan repays it first. */
function owing(calendar = {}, half = false) {
  const {input, now} = monthScenario('normal'), schedule = structuredClone(input); delete schedule.targets; schedule.calendar = calendar;
  const ids = schedule.members.map(m => m.id);
  let events = send([], {kind: 'members', members: ids.map(id => ({id, active: true}))}, 'members');
  [ids[10], ...ids.slice(1).filter(id => id !== ids[10])].forEach((id, k) => {
    events = send(events, {kind: 'claim', debtorId: id, creditorId: ids[0], units: id === ids[10] ? 6 : half && id === ids[8] ? 3 : 4}, `november-${k}`);
  });
  return {i: {schedule, now, seniority: ids, events}, ids};
}
const byPair = rows => Object.fromEntries(Object.entries(rows.reduce((t, r) => {
  const k = `${r.claim.debtorId}>${r.claim.creditorId}`; t[k] = (t[k] ?? 0) + r.units; return t;}, {})).sort());
const drag = (i, d, fromId, toId, units = 2, kind = 'temporary') =>
  transferAllocation(i, d, {id: `${fromId}>${toId}/${d.pairs.length}`, fromId, toId, units, kind}).draft;

test('a repayment handed to someone who owes the same creditor is their own repayment, through Generate and binding', async () => {
  // The reported case: Tamar repays Local Admin (e00) one point and hands it to Lior, who owes
  // Local Admin too. Lior's point repays his own debt; Tamar's stays open. The newest debtors
  // (e11, e10) repay this month, one point each (decision 2026-11-01).
  const {i, ids} = owing(), [owed, tamar, other] = [ids[0], ids[10], ids[11]], [lior, maya] = [ids[7], ids[8]];
  const base = proposeAllocation(i).draft;
  assert.deepEqual(byPair(planAllocation(i, base).plan.repayments), {[`${tamar}>${owed}`]: 2, [`${other}>${owed}`]: 2});
  for (const [label, moves] of [['one receiver', [[tamar, lior]]], ['two debtors, two receivers', [[tamar, lior], [other, maya]]],
    ['two debtors, two receivers, other order', [[other, maya], [tamar, lior]]]]) {
    const d = moves.reduce((x, [from, to]) => drag(i, x, from, to), base);
    const planned = planAllocation(i, d);
    assert.equal(planned.confirmable, true, label);
    assert.deepEqual(planned.plan.intents, [], `${label}: no new debt to the receivers`);
    const expected = {[`${tamar}>${owed}`]: 2, [`${other}>${owed}`]: 2};
    for (const [from, to] of moves) {delete expected[`${from}>${owed}`]; expected[`${to}>${owed}`] = 2;}
    assert.deepEqual(byPair(planned.plan.repayments), Object.fromEntries(Object.entries(expected).sort()), label);
    // Nothing is orphaned: every debt is either repaid this month or still open, unit for unit.
    const owedNow = project(i.events, i.now, i.now).projected.candidates;
    assert.deepEqual(byPair([...planned.plan.repayments, ...planned.plan.deferred]), byPair(owedNow.map(claim => ({claim, units: claim.units}))), label);
    const r = solveGeneration(solver, createGenerationRequest({...i.schedule, targets: Object.fromEntries(ids.map(id => [id, d.targetsUnits[id] / 2]))},
      {now: i.now, seed: 3, seconds: 30}));
    assert.equal(r.complete, true, label);
    const compiled = compileAllocation(i, d, r.assignments);
    assert.equal(compiled.confirmable, true, label);
    assert.deepEqual(byPair(compiled.plan.repayments), byPair(planned.plan.repayments), label);
    const bound = await bindAllocation(i, d, r.assignments, {publicationId: 'p', sourceKey: 'publish/p', actor: 'm'});
    assert.equal(bound.bindable, true, label);
    // Once the month is worked: the deferring debtors still owe everything, each receiver one point less.
    const far = Date.parse(i.schedule.month + '-01T00:00:00Z') + 70 * 86400000, after = project(bound.preview.events, far, far).actual;
    const receivers = moves.map(([, to]) => to);
    assert.ok(!after.claims.some(k => receivers.includes(k.creditorId)), `${label}: nothing owed to a receiver`);
    for (const [from] of moves) assert.equal(after.net[from], from === tamar ? -6 : -4, label);
    for (const id of receivers) assert.equal(after.net[id], -2, label);
  }
});

test('half points hand over exactly: half a point of a deferred repayment repays half a point of the receiver', () => {
  // A split weekend makes half points the step; Maya owes one and a half points.
  const {i, ids} = owing({splitWeekends: ['2026-11-06']}, true), [owed, tamar, maya] = [ids[0], ids[10], ids[8]];
  const d = drag(i, proposeAllocation(i).draft, tamar, maya, 1);
  const planned = planAllocation(i, d);
  assert.equal(planned.confirmable, true);
  assert.equal(byPair(planned.plan.repayments)[`${maya}>${owed}`], 1);
  assert.equal(byPair(planned.plan.repayments)[`${tamar}>${owed}`], 1);
});

test('automatic points spread one per member per round, newest first, and survive Save → reopen', () => {
  const {input, now} = monthScenario('normal'), schedule = structuredClone(input); delete schedule.targets;
  const ids = schedule.members.map(m => m.id);
  const i = {schedule, now, seniority: ids, events: send([], {kind: 'members', members: ids.map(id => ({id, active: true}))}, 'members')};
  const base = proposeAllocation(i).draft, giver = [...ids].sort((a, b) => base.targetsUnits[b] - base.targetsUnits[a])[0];
  for (const points of [2, 3]) {
    const d = editAllocation(i, base, {engineer: giver, deltaUnits: -2 * points, kind: 'temporary'}).draft;
    const gained = ids.filter(id => d.changes[id].temporary > 0);
    assert.ok(gained.every(id => d.changes[id].temporary === 2), `−${points}: one point each, ${JSON.stringify(d.changes)}`);
    assert.equal(gained.length, points);
    // Newest first among the members with the fewest points.
    const others = ids.filter(id => id !== giver), fewest = Math.min(...others.map(id => base.targetsUnits[id]));
    const lowest = others.filter(id => base.targetsUnits[id] === fewest).reverse();
    if (lowest.length >= points) assert.deepEqual(gained, lowest.slice(0, points).sort());
    const reopened = reviewAllocation(i, persistedDraft(d));
    assert.deepEqual(reopened.changes, d.changes);
    assert.deepEqual(reopened.targetsUnits, d.targetsUnits);
  }
});

/** A team in seniority order with debts as [debtor, creditor, units], oldest first. */
function team(month, names, debts) {
  const {input} = monthScenario('normal'), schedule = structuredClone(input); delete schedule.targets;
  schedule.month = month; schedule.calendar = {}; schedule.constraints = {}; schedule.sourceRevision = `team-${month}`;
  schedule.members = names.map(id => ({id, active: true, approved: true, eligible: true}));
  let events = send([], {kind: 'members', members: names.map(id => ({id, active: true}))}, 'members');
  debts.forEach(([debtorId, creditorId, units], k) => {events = send(events, {kind: 'claim', debtorId, creditorId, units}, `debt-${k}`);});
  return {schedule, now: Date.parse(`${month}-01T00:00:00Z`) - 7 * 86400000, seniority: names, events};
}
const points = d => Object.fromEntries(Object.entries(d.targetsUnits).map(([id, u]) => [id, u / 2]));

test('one extra each before anyone gets two: the January case repays in turns, newest first', () => {
  // The reported January (decision 2026-11-01): Local Admin's relief this month is two points.
  // It was repaid by Tamar alone (her oldest debt, both points); now Local Admin's debtors take
  // turns, newest first: Shira and Omer repay one point each, and the two leftover points go
  // newest first to members without a point extra, Tamar and Lior.
  const names = ['Local Admin', 'Local Engineer', 'Avi', 'Dana', 'Yossi', 'Noa', 'Eitan', 'Maya', 'Lior', 'Tamar', 'Omer', 'Shira'];
  const i = team('2027-01', names, [['Tamar', 'Local Admin', 4], ...names.slice(1).filter(n => n !== 'Tamar').map(n => [n, 'Local Admin', n === 'Shira' ? 6 : 4])]);
  const d = proposeAllocation(i).draft;
  assert.deepEqual(d.repayments.map(r => [r.claim.debtorId, r.units / 2]), [['Shira', 1], ['Omer', 1]]);
  assert.deepEqual(points(d), {'Local Admin': 0, 'Local Engineer': 2, Avi: 2, Dana: 2, Yossi: 2, Noa: 2, Eitan: 2, Maya: 2, Lior: 3, Tamar: 3, Omer: 3, Shira: 3});
  assert.equal(planAllocation(i, d).confirmable, true);
  // Save → reopen and a fresh proposal from the saved plan give the same table.
  assert.deepEqual(reviewAllocation(i, persistedDraft(d)).targetsUnits, d.targetsUnits);
  assert.deepEqual(proposeAllocation(i, {hand: {}, pairs: [], baselineUnits: d.baselineUnits}).draft.targetsUnits, d.targetsUnits);
});

test('a point received permanently and handed to a debtor is that debtor\'s repayment: the January 2027 plan books', async () => {
  // The reported plan (2026-11-01): Local Engineer, Avi and Dana each owe Local Admin two points.
  // The turns repay Dana and Avi one point each. The manager then gave Local Admin a point
  // permanently, dragged a point from Local Admin to Local Engineer, and took a point permanently
  // from Omer. Local Admin's point to Local Engineer is the one Local Admin just received
  // permanently; it was refused after Generate ("can't be booked") as a compound route.
  // Permanent legs owe nothing, so it is Local Engineer's own repayment to Local Admin.
  const names = ['Local Admin', 'Local Engineer', 'Avi', 'Dana', 'Yossi', 'Noa', 'Eitan', 'Maya', 'Lior', 'Tamar', 'Omer', 'Shira'];
  const admin = 'Local Admin', engineer = 'Local Engineer';
  const i = team('2027-01', names, [[engineer, admin, 4], ['Avi', admin, 4], ['Dana', admin, 4]]);
  let d = editAllocation(i, proposeAllocation(i).draft, {engineer: admin, deltaUnits: 2, kind: 'permanent'}).draft;
  d = editAllocation(i, drag(i, d, admin, engineer), {engineer: 'Omer', deltaUnits: -2, kind: 'permanent'}).draft;
  assert.deepEqual(points(d), {Avi: 3, Dana: 3, Eitan: 2, Lior: 2, [admin]: 0, [engineer]: 3, Maya: 2, Noa: 2, Omer: 2, Shira: 3, Tamar: 2, Yossi: 2});
  assert.deepEqual(Object.fromEntries(Object.entries(d.changes).filter(([, c]) => c.temporary || c.permanent)),
    {[admin]: {temporary: -2, permanent: 2}, [engineer]: {temporary: 2, permanent: 0}, Omer: {temporary: 0, permanent: -2}});
  const planned = planAllocation(i, d);
  assert.equal(planned.confirmable, true, JSON.stringify(planned.diagnostics));
  assert.deepEqual(planned.plan.intents, [], 'no new debt: Omer\'s permanent point owes nothing, Local Engineer\'s point repays');
  assert.deepEqual(byPair(planned.plan.repayments), {[`Avi>${admin}`]: 2, [`Dana>${admin}`]: 2, [`${engineer}>${admin}`]: 2});
  assert.deepEqual(byPair(planned.plan.deferred), {[`Avi>${admin}`]: 2, [`Dana>${admin}`]: 2, [`${engineer}>${admin}`]: 2});
  // Through Generate, compile and binding, then the ledger once the month is worked.
  const r = solveGeneration(solver, createGenerationRequest({...i.schedule, targets: Object.fromEntries(names.map(id => [id, d.targetsUnits[id] / 2]))},
    {now: i.now, seed: 3, seconds: 30}));
  assert.equal(r.complete, true);
  assert.equal(compileAllocation(i, d, r.assignments).confirmable, true);
  const bound = await bindAllocation(i, d, r.assignments, {publicationId: 'p', sourceKey: 'publish/p', actor: 'm'});
  assert.equal(bound.bindable, true, bound.diagnostics.at(-1)?.code);
  const far = Date.parse('2027-01-01T00:00:00Z') + 70 * 86400000, after = project(bound.preview.events, far, far).actual;
  assert.deepEqual(byPair(after.claims.map(claim => ({claim, units: claim.units}))), {[`Avi>${admin}`]: 2, [`Dana>${admin}`]: 2, [`${engineer}>${admin}`]: 2});
});

test('a point given permanently and handed back temporarily is a plain loan: the route drops its permanent leg and binds', async () => {
  // Omer gives Local Admin a point for good, then Local Admin, whose own share is all relief,
  // hands that point back to Omer. Permanent legs owe nothing (decision 2026-11-01), so it books
  // as Local Admin owing Omer one point; it was published as an intent from Omer to Omer before
  // (invalid-endpoints).
  const names = ['Local Admin', 'Local Engineer', 'Avi', 'Dana', 'Yossi', 'Noa', 'Eitan', 'Maya', 'Lior', 'Tamar', 'Omer', 'Shira'];
  const admin = 'Local Admin', i = team('2027-01', names, [['Local Engineer', admin, 4], ['Avi', admin, 4], ['Dana', admin, 4]]);
  const d = drag(i, drag(i, proposeAllocation(i).draft, 'Omer', admin, 2, 'permanent'), admin, 'Omer');
  const planned = planAllocation(i, d);
  assert.equal(planned.confirmable, true);
  assert.deepEqual(planned.plan.funding.map(f => [f.carrierId, f.units, f.route.map(l => [l.fromId, l.toId, l.kind])]), [['Omer', 2, [[admin, 'Omer', 'temporary']]]]);
  const r = solveGeneration(solver, createGenerationRequest({...i.schedule, targets: Object.fromEntries(names.map(id => [id, d.targetsUnits[id] / 2]))},
    {now: i.now, seed: 3, seconds: 30}));
  assert.equal(r.complete, true);
  const bound = await bindAllocation(i, d, r.assignments, {publicationId: 'p', sourceKey: 'publish/p', actor: 'm'});
  assert.equal(bound.bindable, true, bound.diagnostics.at(-1)?.code);
  const far = Date.parse('2027-01-01T00:00:00Z') + 70 * 86400000, after = project(bound.preview.events, far, far).actual;
  assert.equal(after.net.Omer, 2, 'Local Admin owes Omer one point');
  assert.equal(after.net[admin], 12 - 2 - 2 - 2, 'owed six points: Avi and Dana repaid one each, and Local Admin owes Omer one');
});

/** Publish a month's planned repayments as ledger reservations, one per duty-sized unit pair. */
function publish(i, draft, month, at) {
  const days = Array.from({length: 28}, (_, k) => `${month}-${String(k + 1).padStart(2, '0')}`), duties = [], reservations = [];
  for (const r of draft.repayments) for (let off = 0; off < r.units; off += 2) {
    const units = Math.min(2, r.units - off), date = days[duties.length];
    duties.push({startDate: date, endDate: days[duties.length + 1], primaryId: r.claim.debtorId, units});
    reservations.push({id: `${month}/${reservations.length}`, capacity: {date, offset: 0, units}, claim: sliceClaim(r.claim, units, off)});
  }
  i.events = send(i.events, {kind: 'publication', month, beforeId: null, after: {id: `pub-${month}`, month, duties, intents: [], reservations}}, `publish-${month}`, at);
}
const repaid = d => d.repayments.map(r => [r.claim.debtorId, r.claim.creditorId, r.units / 2]);

test('turns: a single debtor repays as much as the relief allows; three debtors share four points 2/1/1', () => {
  // A owes B two points and nobody else owes B: both points come back this month.
  const names = Array.from({length: 12}, (_, k) => `m${String(k).padStart(2, '0')}`);
  const single = proposeAllocation(team('2026-11', names, [['m05', 'm02', 4]])).draft;
  assert.deepEqual(repaid(single), [['m05', 'm02', 2]]);
  assert.equal(single.targetsUnits.m05 - single.baselineUnits.m05, 4); assert.equal(single.targetsUnits.m02, 0);
  // Three debtors of one creditor relieved by four points: D (newest) twice, C and B once.
  const i = team('2026-11', ['A', 'B', 'C', 'D'], [['B', 'A', 2], ['C', 'A', 2], ['D', 'A', 4]]), d = proposeAllocation(i).draft;
  assert.deepEqual(repaid(d), [['D', 'A', 2], ['C', 'A', 1], ['B', 'A', 1]]);
  assert.equal(planAllocation(i, d).confirmable, true);
});

test('turns carry over: B, C and D owe A two points each, cleared over two months', () => {
  const names = ['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'B', 'C', 'D'];
  const owing = [['B', 'A', 4], ['C', 'A', 4], ['D', 'A', 4]];
  const december = i => ({...i, schedule: {...i.schedule, month: '2026-12', sourceRevision: 'team-2026-12'}});
  // A's fair share is three points (A is newest, so A takes a remainder): A goes to 0, D, C and B +1.
  const i = team('2026-11', [...names, 'A'], owing), first = proposeAllocation(i).draft;
  assert.equal(first.baselineUnits.A, 6);
  assert.deepEqual(repaid(first), [['D', 'A', 1], ['C', 'A', 1], ['B', 'A', 1]]);
  assert.equal(first.targetsUnits.A, 0);
  publish(i, first, '2026-11', 100);
  const next = proposeAllocation(december(i)).draft;
  assert.equal(next.baselineUnits.A, 6);
  assert.deepEqual(repaid(next), [['D', 'A', 1], ['C', 'A', 1], ['B', 'A', 1]], 'the same again clears every debt');
  // A's share is two points (A most senior): D and C repay in November, B goes first in December.
  const j = team('2026-11', ['A', ...names], owing), november = proposeAllocation(j).draft;
  assert.equal(november.baselineUnits.A, 4);
  assert.deepEqual(repaid(november), [['D', 'A', 1], ['C', 'A', 1]]);
  publish(j, november, '2026-11', 100);
  const after = proposeAllocation(december(j)).draft;
  assert.deepEqual(repaid(after), [['B', 'A', 1], ['D', 'A', 1]]);
  // A never goes below its locks: a locked duty of A's leaves two points of relief.
  const k = team('2026-11', [...names, 'A'], owing);
  k.schedule.locks = [{dutyId: '2026-11-02', engineer: 'A'}];
  const locked = proposeAllocation(k).draft;
  assert.deepEqual(repaid(locked), [['D', 'A', 1], ['C', 'A', 1]]);
  assert.equal(locked.targetsUnits.A, 2);
  for (const draft of [first, next, november, after, locked]) assert.ok(Object.values(draft.targetsUnits).every(u => u >= 0));
});

test('a second extra point only when every member already has one', () => {
  // Three members, two leftover points, two one-point debtors: the creditor takes the first
  // leftover, the newest repayer the second (more extras than members without one).
  const i = team('2026-11', ['a', 'b', 'c'], [['b', 'a', 2], ['c', 'a', 2]]), d = proposeAllocation(i).draft;
  const low = Math.min(...Object.values(d.baselineUnits)), paid = id => d.repayments.filter(r => r.claim.debtorId === id).reduce((n, r) => n + r.units, 0);
  const extra = Object.fromEntries(['a', 'b', 'c'].map(id => [id, (d.baselineUnits[id] - low + paid(id)) / 2]));
  assert.deepEqual(repaid(d), [['c', 'a', 1], ['b', 'a', 1]]);
  assert.ok(Object.values(extra).every(n => n >= 1), JSON.stringify(points(d)));
  assert.deepEqual(Object.entries(extra).filter(([, n]) => n === 2).map(([id]) => id), ['c']);
  assert.equal(planAllocation(i, d).confirmable, true);
});

test('several creditors: each creditor has its own turns, newest first', () => {
  const names = Array.from({length: 12}, (_, k) => `m${String(k).padStart(2, '0')}`);
  const i = team('2026-11', names, [['m09', 'm00', 4], ['m09', 'm01', 4], ['m10', 'm00', 4], ['m11', 'm01', 4]]);
  const d = proposeAllocation(i).draft;
  // m00 (the oldest debt) is relieved by m10 then m09, m01 by m11 then m09.
  assert.deepEqual(repaid(d), [['m10', 'm00', 1], ['m09', 'm00', 1], ['m11', 'm01', 1], ['m09', 'm01', 1]]);
  assert.deepEqual([d.targetsUnits.m00, d.targetsUnits.m01], [0, 0]);
  assert.equal(planAllocation(i, d).confirmable, true);
});
