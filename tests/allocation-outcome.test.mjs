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
  // The reported case: Tamar (e10) repays Local Admin (e00) and hands one point to Lior (e07),
  // who owes Local Admin too. Lior's point repays his own debt; Tamar's stays open.
  const {i, ids} = owing(), [owed, tamar, lior, maya] = [ids[0], ids[10], ids[7], ids[8]];
  const base = proposeAllocation(i).draft;
  assert.deepEqual(byPair(planAllocation(i, base).plan.repayments), {[`${tamar}>${owed}`]: 4});
  for (const [label, receivers] of [['one receiver', [lior]], ['two receivers', [lior, maya]], ['two receivers, other order', [maya, lior]]]) {
    const d = receivers.reduce((x, to) => drag(i, x, tamar, to), base);
    const planned = planAllocation(i, d);
    assert.equal(planned.confirmable, true, label);
    assert.deepEqual(planned.plan.intents, [], `${label}: no new debt to the receivers`);
    const expected = {[`${tamar}>${owed}`]: 4 - 2 * receivers.length};
    for (const r of receivers) expected[`${r}>${owed}`] = 2;
    assert.deepEqual(byPair(planned.plan.repayments), Object.fromEntries(Object.entries(expected).filter(([, n]) => n).sort()), label);
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
    // Once the month is worked: Tamar still owes the deferred units, each receiver two fewer, nobody owes a receiver.
    const far = Date.parse(i.schedule.month + '-01T00:00:00Z') + 70 * 86400000, after = project(bound.preview.events, far, far).actual;
    assert.ok(!after.claims.some(k => receivers.includes(k.creditorId)), `${label}: nothing owed to a receiver`);
    assert.equal(after.net[tamar], -(6 - (4 - 2 * receivers.length)), label);
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
  assert.equal(byPair(planned.plan.repayments)[`${tamar}>${owed}`], 3);
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
