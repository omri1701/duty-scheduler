import test from 'node:test';
import assert from 'node:assert/strict';
import loadHighs from 'highs';
import {createHighsAdapter, canonicalDuties, validateGeneration} from '../lib/scheduling/index.ts';
import {record, replay, sliceClaim} from '../lib/compensation/index.ts';
import {proposeAllocation, editAllocation, compileAllocation, assessAllocation} from '../lib/allocation/index.ts';
import {monthScenario} from './fixtures/generation.mjs';

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
const proposal = i => proposeAllocation(solver, i, {seconds: 10});
const edit = (i, d, engineer, deltaUnits, kind = 'temporary', id = 'edit') =>
  editAllocation(solver, i, d, {id, engineer, deltaUnits, kind}, {seconds: 4});
const compiled = (i, d) => compileAllocation(solver, i, d, {seconds: 4});
function invariant(i, r) {
  const duties = canonicalDuties(i.schedule.month, i.schedule.calendar);
  assert.equal(total(Object.values(r.draft.baselineUnits)), total(duties.map(d => d.units)));
  assert.equal(total(Object.values(r.draft.targetsUnits)), total(duties.map(d => d.units)));
  if (r.check.assignments) validateGeneration({...i.schedule,
    targets: Object.fromEntries(Object.entries(r.draft.targetsUnits).map(([k, v]) => [k, v / 2]))}, r.check.assignments);
  assert.equal(solver.activeModels, 0);
}
function freeze(v) {if (v && typeof v === 'object') {Object.values(v).forEach(freeze); Object.freeze(v);} return v;}

const normalInput = freeze(scenario()), normal = proposal(normalInput);

test('ordinary baseline uses exact attainable weights; saved seniority only breaks equivalent choices', () => {
  invariant(normalInput, normal);
  assert.equal(normal.optimal, true); assert.equal(normal.check.feasibility, 'complete');
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

test('repayment has no monthly cap, respects creditor relief and precedes seniority', () => {
  const i = owe(scenario(), 'e11', 'e00', 8, 'old'), r = proposal(i);
  invariant(i, r); assert.equal(r.optimal, true);
  assert.equal(r.draft.baselineUnits.e00, 6, 'equivalent ordinary baseline retained for repayment');
  assert.equal(total(r.draft.repayments.map(p => p.units)), 6, 'three points, bounded by ordinary creditor share');
  assert.equal(r.draft.targetsUnits.e00, 0);
  assert.equal(r.draft.targetsUnits.e11, r.draft.baselineUnits.e11 + 6);
  const p = compiled(i, r.draft).plan;
  assert.equal(total(p.repayments.map(r => r.units)), 6); assert.equal(total(p.deferred.map(r => r.units)), 2);
  assert.deepEqual(p.intents, []);
});

test('partial oldest repayment uses real half duties; a younger claim cannot take its capacity', () => {
  const i = owe(owe(scenario(), 'e00', 'e11', 4, 'old'), 'e00', 'e10', 2, 'young');
  i.schedule.calendar.splitWeekends = ['2026-11-06'];
  const allowed = ['2026-11-01', '2026-11-04', '2026-11-06', '2026-11-09'];
  i.schedule.constraints.e00 = Object.fromEntries(canonicalDuties(i.schedule.month, i.schedule.calendar)
    .flatMap(d => allowed.includes(d.id) ? [] : d.dates.map(date => [date, 'no'])));
  const r = proposal(i); invariant(i, r);
  assert.equal(r.optimal, true); assert.equal(r.check.feasibility, 'complete');
  assert.deepEqual(r.draft.repayments.map(r => [r.claim.priority.lotId, r.units]), [['old', 3]]);
  assert.equal(r.draft.targetsUnits.e00, 7);
});

test('an older infeasible claim stays open while a feasible younger obligation progresses', () => {
  const i = owe(owe(scenario(), 'e00', 'e11', 4, 'old'), 'e01', 'e10', 2, 'young');
  i.schedule.constraints.e00 = Object.fromEntries(canonicalDuties(i.schedule.month, {}).flatMap(d =>
    ['2026-11-01', '2026-11-02', '2026-11-03'].includes(d.id) ? [] : d.dates.map(date => [date, 'no'])));
  const r = proposal(i); invariant(i, r);
  assert.deepEqual(r.draft.repayments.map(r => [r.claim.priority.lotId, r.units]), [['young', 2]]);
  assert.ok(compiled(i, r.draft).plan.deferred.some(p => p.claim.path[0].lotId === 'old' && p.units === 4));
});

test('half-point debt cannot split a whole-point duty or manufacture a rounding transfer', () => {
  const i = owe(scenario(), 'e00', 'e11', 1, 'half'), r = proposal(i);
  assert.equal(r.optimal, true); assert.deepEqual(r.draft.repayments, []); assert.deepEqual(r.draft.transfers, []);
  assert.equal(compiled(i, r.draft).plan.deferred[0].units, 1);
});

test('availability relief is explicit temporary intent; ordinary baseline remains fair', () => {
  const i = scenario();
  i.schedule.constraints.e00 = Object.fromEntries(canonicalDuties(i.schedule.month, {}).flatMap(d => d.dates.map(date => [date, 'no'])));
  const r = proposal(i); invariant(i, r);
  assert.equal(r.check.feasibility, 'complete'); assert.equal(r.draft.baselineUnits.e00, 4);
  assert.equal(r.draft.targetsUnits.e00, 0); assert.equal(r.reviewRequired, true);
  assert.ok(r.draft.transfers.every(t => t.fromId === 'e00' && t.kind === 'temporary'));
  const p = compiled(i, r.draft).plan;
  assert.equal(total(p.intents.map(t => t.units)), 4);
  assert.ok(p.intents.every(t => t.fromId === 'e00'));
});

test('temporary/permanent counterpart preferences, wrapping and whole-request precedence', () => {
  const d = normal.draft, i = normalInput;
  const temp = edit(i, d, 'e11', -2);
  assert.deepEqual(temp.draft.transfers.map(t => [t.fromId, t.toId, t.units]), [['e11', 'e00', 2]]);
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

test('unplaceable edits preserve the requested limit; explicit controls consume pending provenance', () => {
  const i = normalInput, first = edit(i, normal.draft, 'e00', -1);
  assert.equal(first.balanced, false); assert.equal(first.draft.targetsUnits.e00, 3);
  assert.equal(first.draft.pending[0].deltaUnits, -1);
  assert.equal(compiled(i, first.draft).confirmable, false);
  const undone = edit(i, first.draft, 'e00', 1, 'temporary', 'undo');
  assert.equal(undone.balanced, true); assert.deepEqual(undone.draft.targetsUnits, normal.draft.targetsUnits);
  assert.deepEqual(undone.draft.transfers, []); assert.deepEqual(undone.draft.pending, []);
  const second = edit(i, first.draft, 'e01', 1, 'temporary', 'finish');
  assert.equal(second.balanced, true); assert.deepEqual(second.draft.pending, []);
  assert.deepEqual(second.draft.transfers.map(t => [t.fromId, t.toId, t.units]), [['e00', 'e01', 1]]);
  const p = compiled(i, second.draft);
  assert.equal(p.check.feasibility, 'partial'); assert.equal(p.confirmable, true);
  assert.deepEqual(p.plan.intents, [], 'unperformed burden creates no debt');
  assert.equal(p.plan.unfundedUnits.e01, 1);
});

test('manual deferral reroutes through the creditor once, preserves source age and does not settle', () => {
  const i = owe(scenario(), 'e00', 'e11', 8, 'old'), before = structuredClone(i.events), r = proposal(i);
  const changed = edit(i, r.draft, 'e00', -2), p = compiled(i, changed.draft).plan;
  assert.equal(total(p.repayments.map(p => p.units)), 4);
  assert.equal(total(p.deferred.map(p => p.units)), 4);
  assert.deepEqual(p.intents.map(t => [t.fromId, t.toId, t.units, t.kind]), [['e11', 'e01', 2, 'temporary']]);
  assert.equal(p.intents[0].deferredClaim.path[0].lotId, 'old');
  for (const repayment of p.repayments) for (const a of repayment.claim.path) {
    for (const intent of p.intents) for (const b of intent.deferredClaim?.path ?? []) {
      assert.ok(a.lotId !== b.lotId || a.offset + a.units <= b.offset || b.offset + b.units <= a.offset,
        'rerouted source slices cannot also fund repayment');
    }
    for (const deferred of p.deferred) for (const b of deferred.claim.path) {
      assert.ok(a.lotId !== b.lotId || a.offset + a.units <= b.offset || b.offset + b.units <= a.offset);
    }
  }
  // Existing core independently checks the resulting debt network, without
  // creating both D->C and D->recipient for the same deferred work.
  let history = send(i.events, {kind: 'claim', debtorId: 'e11', creditorId: 'e01', units: 2}, 'approved-burden');
  history = send(history, {kind: 'adjust', mode: 'settle', claim: p.repayments[0].claim, units: 4}, 'completed-work');
  assert.deepEqual(replay(history).net, {e00: -4, e01: 2, e02: 0, e03: 0, e04: 0, e05: 0, e06: 0, e07: 0, e08: 0, e09: 0, e10: 0, e11: 2});
  assert.deepEqual(i.events, before);
  const permanent = compiled(i, edit(i, r.draft, 'e00', -2, 'permanent').draft).plan;
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
  assert.ok(r.draft.baselineUnits.e00 < 8); assert.ok(r.draft.targetsUnits.e00 >= 8);
  assert.ok(r.check.diagnostics.some(d => d.code === 'classify-locked-target-increase'));
  assert.throws(() => edit(i, r.draft, 'e00', -r.draft.targetsUnits.e00), /edit-below-locked-points/);
});

test('partial months retain all required nominal points and independently valid coverage', () => {
  for (const kind of ['small-team', 'weighted', 'boundary']) {
    const i = scenario(kind), r = proposal(i); invariant(i, r);
    assert.equal(r.optimal, true, kind);
    assert.equal(r.check.feasibility, kind === 'small-team' ? 'partial' : 'complete', kind);
    if (kind === 'small-team') assert.ok(total(Object.values(r.draft.targetsUnits)) > r.check.assignedUnits);
  }
});

test('partial compilation chooses an equally covered witness that funds feasible repayment', () => {
  const i = scenario();
  i.schedule.members = i.schedule.members.slice(0, 3); i.seniority = i.seniority.slice(0, 3);
  owe(i, 'e00', 'e02', 2, 'old');
  const r = proposal(i), p = compiled(i, r.draft); invariant(i, r);
  assert.equal(p.check.feasibility, 'partial');
  assert.equal(total(p.plan.repayments.map(r => r.units)), 2);
  assert.ok(p.check.stages.some(s => s.name.startsWith('funding:') && s.proved));
});

test('zero budget stays UNKNOWN; confirmed targets remain verbatim; source changes invalidate drafts', () => {
  const r = proposeAllocation(solver, normalInput, {seconds: 0});
  assert.equal(r.optimal, false); assert.equal(r.check.feasibility, 'unknown');
  assert.ok(r.check.diagnostics.some(d => d.certainty === 'unproved'));
  const before = structuredClone(normal.draft);
  assert.equal(assessAllocation(solver, normalInput, freeze(structuredClone(before)), {seconds: 0}).feasibility, 'unknown');
  const pending = editAllocation(solver, normalInput, before,
    {id: 'unknown', engineer: 'e00', deltaUnits: -2, kind: 'temporary'}, {seconds: 0});
  assert.equal(pending.draft.targetsUnits.e00, 2); assert.equal(pending.balanced, false);
  assert.ok(pending.diagnostics.some(d => d.code === 'counterpart-feasibility-unproved'));
  assert.deepEqual(normal.draft, before);
  const reordered = {...normalInput, seniority: [...normalInput.seniority].reverse()};
  assert.throws(() => assessAllocation(solver, reordered, before), /stale-allocation/);
  for (const change of [
    i => i.schedule.sourceRevision += '-new',
    i => i.schedule.calendar.splitWeekends = ['2026-11-06'],
    i => i.schedule.constraints.e00 = {'2026-11-01': 'no'},
  ]) {const i = structuredClone(normalInput); change(i); assert.throws(() => compiled(i, before), /stale-allocation/);}
  assert.throws(() => edit(normalInput, before, 'e00', 0.5), /invalid-allocation-edit/);
  assert.throws(() => proposal({...normalInput, seniority: ['e00']}), /invalid-allocation-seniority/);
});

test('duplicate/unexplained accounting slices are rejected', () => {
  const i = owe(scenario(), 'e00', 'e11', 4, 'old'), r = proposal(i), duplicate = structuredClone(r.draft);
  duplicate.repayments.push(structuredClone(duplicate.repayments[0]));
  assert.throws(() => compiled(i, duplicate), /duplicate-repayment-source/);
  const edited = structuredClone(r.draft); edited.targetsUnits.e00++;
  assert.throws(() => compiled(i, edited), /unexplained-target-edit/);
  const forged = structuredClone(r.draft); forged.repayments[0].claim.priority.at = 0;
  assert.throws(() => compiled(i, forged), /invalid-repayment-source/);
  assert.equal(solver.activeModels, 0);
});
