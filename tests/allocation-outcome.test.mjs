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
import {record, project} from '../lib/compensation/index.ts';
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

test('one extra each before anyone gets two: the January case repays newest first, one point each', () => {
  // The reported January (decision 2026-11-01): Local Admin's relief this month is two points.
  // It was repaid by Tamar alone (her oldest debt, both points); now the newest debtors Shira and
  // Omer repay one point each, and the two leftover points go newest first to members without
  // a point extra: Tamar and Lior.
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

test('a second extra point only when every member already has one', () => {
  // Three members, two leftover points, two debtors: the creditor takes the first leftover,
  // the newest repayer the second (more extras than members without one).
  const i = team('2026-11', ['a', 'b', 'c'], [['b', 'a', 4], ['c', 'a', 4]]), d = proposeAllocation(i).draft;
  // Extra points: a leftover share above the smallest, plus repayment work.
  const low = Math.min(...Object.values(d.baselineUnits)), repaid = id => d.repayments.filter(r => r.claim.debtorId === id).reduce((n, r) => n + r.units, 0);
  const extra = Object.fromEntries(['a', 'b', 'c'].map(id => [id, (d.baselineUnits[id] - low + repaid(id)) / 2]));
  assert.deepEqual(d.repayments.map(r => [r.claim.debtorId, r.units / 2]), [['c', 1], ['b', 1]]);
  assert.ok(Object.values(extra).every(n => n >= 1), JSON.stringify(points(d)));
  assert.deepEqual(Object.entries(extra).filter(([, n]) => n === 2).map(([id]) => id), ['c']);
  assert.equal(planAllocation(i, d).confirmable, true);
});

test('several creditors: newest debtors first per creditor, one point per debtor in all', () => {
  const names = Array.from({length: 12}, (_, k) => `m${String(k).padStart(2, '0')}`);
  const i = team('2026-11', names, [['m09', 'm00', 4], ['m09', 'm01', 4], ['m10', 'm00', 4], ['m11', 'm01', 4]]);
  const d = proposeAllocation(i).draft;
  // m00 has the oldest debt, so it is served first: m10 and m09 repay it; m09 has then used its
  // point, so only m11 repays m01.
  assert.deepEqual(d.repayments.map(r => [r.claim.debtorId, r.claim.creditorId, r.units / 2]), [['m10', 'm00', 1], ['m09', 'm00', 1], ['m11', 'm01', 1]]);
  assert.equal(planAllocation(i, d).confirmable, true);
});
