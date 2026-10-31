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
import {record} from '../lib/compensation/index.ts';
import {proposeAllocation, transferAllocation, compileAllocation, planAllocation} from '../lib/allocation/index.ts';
import {chainedDeferrals} from '../lib/allocation/outcome.ts';
import {monthScenario} from './fixtures/generation.mjs';

const send = (h, operation, sourceKey, at = (h.at(-1)?.at ?? 0) + 1) => record(h,
  {operation, sourceKey, at, actor: 'manager', reason: 'Reviewed fixture'}).events;

test('a repayment put off through others who owe the same person is named before Generate; the alternatives book', async () => {
  // The reported December: after a published month every member owes e00, and e10's plan
  // repays e00 4 units. Lowering e10 by 4 with the points dragged to e07 and e08, who owe
  // e00 too, cannot be booked: it used to fail only after Generate, in raw English.
  const {input, now} = monthScenario('normal'), schedule = structuredClone(input); delete schedule.targets;
  const ids = schedule.members.map(m => m.id);
  let events = send([], {kind: 'members', members: ids.map(id => ({id, active: true}))}, 'members');
  // e10's debt is the oldest, so the plan repays it first (the creditor's relief runs out after it).
  [ids[10], ...ids.slice(1).filter(id => id !== ids[10])].forEach((id, k) => {
    events = send(events, {kind: 'claim', debtorId: id, creditorId: ids[0], units: id === ids[10] ? 6 : 4}, `november-${k}`);
  });
  const i = {schedule, now, seniority: ids, events};
  const base = proposeAllocation(i).draft;
  assert.deepEqual(base.repayments.map(r => [r.claim.debtorId, r.claim.creditorId]).filter(([d]) => d === ids[10]), [[ids[10], ids[0]]]);
  const drag = (d, toId, kind = 'temporary') => transferAllocation(i, d, {id: `${toId}/${d.pairs.length}`, fromId: ids[10], toId, units: 2, kind}).draft;
  const chained = drag(drag(base, ids[7]), ids[8]);
  assert.equal(planAllocation(i, chained).confirmable, false);
  assert.deepEqual(chainedDeferrals(i, chained).map(d => [d.debtorId, d.creditorId, [...d.via].sort()]), [[ids[10], ids[0], [ids[7], ids[8]].sort()]]);
  // Giving the points to the person owed, or making the change Permanent, books normally,
  // and the generated month then meets the plan exactly.
  const solver = await createHighsAdapter(loadHighs);
  for (const fixed of [drag(drag(base, ids[0]), ids[0]), drag(drag(base, ids[7], 'permanent'), ids[8], 'permanent')]) {
    assert.equal(planAllocation(i, fixed).confirmable, true);
    assert.deepEqual(chainedDeferrals(i, fixed), []);
    const r = solveGeneration(solver, createGenerationRequest({...schedule, targets: Object.fromEntries(ids.map(id => [id, fixed.targetsUnits[id] / 2]))},
      {now, seed: 3, seconds: 30}));
    assert.equal(r.complete, true);
    assert.equal(compileAllocation(i, fixed, r.assignments).confirmable, true);
  }
});
