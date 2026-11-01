import test from 'node:test';
import assert from 'node:assert/strict';
import loadHighs from 'highs';
import {createHighsAdapter, canonicalDuties, coverageStart, createGenerationRequest, solveGeneration, validateGeneration,
  prepareGeneration, generationRotations, weekendRotation} from '../lib/scheduling/index.ts';
import {requireWeekendEligibility} from '../lib/scheduling/validate.ts';
import {record} from '../lib/compensation/index.ts';
import {proposeAllocation, editAllocation, compileAllocation, retainedChanges, balanced, editOptions} from '../lib/allocation/index.ts';
import {NON_WEEKEND_UNITS} from '../lib/allocation/planner.ts';
import {permanentCeiling} from '../lib/allocation/edits.ts';
import {monthScenario} from './fixtures/generation.mjs';

// Non-weekend members (decision 2026-11-01): never on a weekend in Generate, left out of
// the weekend rotation, and a default +1 Permanent in Plan the month.
const solver = await createHighsAdapter(loadHighs);
const sum = xs => xs.reduce((a, b) => a + b, 0);
const far = ['e01', 'e05'];
function generationInput(kind = 'normal') {
  const {input} = monthScenario(kind);
  return {...input, members: input.members.map(m => far.includes(m.id) ? {...m, noWeekends: true} : m)};
}
const run = (input, seed = 17) => solveGeneration(solver, createGenerationRequest(input,
  {now: coverageStart(input.month, input.calendar) - 1, seed, seconds: 5}));
const weekends = (input, assignments, id) => canonicalDuties(input.month, input.calendar)
  .filter(d => d.weekendId && assignments[d.id].primary === id).map(d => d.id);

test('Generate never places a non-weekend member on a weekend, including holiday weekends and split halves', () => {
  // 'weighted' has a holiday weekend and two hand-split weekends.
  for (const kind of ['normal', 'weighted']) {
    const input = generationInput(kind), duties = canonicalDuties(input.month, input.calendar);
    // Targets the witness gave the far members are kept; their weekend points move to weekdays elsewhere.
    for (const seed of [17, 1701]) {
      const r = run(input, seed);
      for (const id of far) assert.deepEqual(weekends(input, r.assignments, id), [], `${kind}/${seed}: ${id} has no weekend`);
      assert.deepEqual(validateGeneration(input, r.assignments), r.metrics);
      assert.equal(r.metrics.coverage, sum(duties.map(d => d.dates.length)), `${kind}/${seed}: every date covered`);
    }
    // A hard eligibility rule: no weekend candidate at all, every weekday unchanged.
    const prepared = prepareGeneration(input), plain = prepareGeneration(monthScenario(kind).input);
    const indices = far.map(id => prepared.members.findIndex(m => m.id === id));
    for (const [i, d] of prepared.problem.duties.entries()) {
      if (d.weekend !== undefined) assert.deepEqual(indices.filter(e => d.eligible.includes(e)), [], `${kind}: weekend duty ${i}`);
      else assert.deepEqual(d.eligible, plain.problem.duties[i].eligible, `${kind}: weekday duty ${i}`);
    }
  }
});

test('a weekend locked to a non-weekend member is kept, never dropped', () => {
  const input = generationInput(), weekend = canonicalDuties(input.month, input.calendar).find(d => d.weekendId);
  const locked = {...input, locks: [{dutyId: weekend.id, engineer: 'e01'}]};
  const r = run(locked);
  assert.equal(r.assignments[weekend.id].primary, 'e01');
  assert.deepEqual(weekends(locked, r.assignments, 'e01'), [weekend.id]);
  assert.deepEqual(weekends(locked, r.assignments, 'e05'), []);
});

test('only Generate output is held to the rule: manual edits still validate, unlocked generated weekends are refused', () => {
  const input = generationInput(), duties = canonicalDuties(input.month, input.calendar);
  const weekend = duties.find(d => d.weekendId), prepared = prepareGeneration(input);
  const assignments = Object.fromEntries(duties.map(d => [d.id, {primary: null}]));
  assignments[weekend.id] = {primary: 'e01'};
  assert.throws(() => requireWeekendEligibility(prepared, assignments), /non-weekend-primary/);
  // A manager's manual placement (publication, review) is the manager's call.
  assert.doesNotThrow(() => validateGeneration(input, assignments));
  const locked = prepareGeneration({...input, locks: [{dutyId: weekend.id, engineer: 'e01'}]});
  assert.doesNotThrow(() => requireWeekendEligibility(locked, assignments));
  assert.throws(() => prepareGeneration({...input, members: input.members.map((m, i) => i ? m : {...m, noWeekends: 'yes'})}), /invalid-member/);
  // Absent and false are the same: existing inputs are unchanged.
  assert.deepEqual(prepareGeneration({...input, members: input.members.map(m => ({...m, noWeekends: false}))}).problem.duties,
    prepareGeneration(monthScenario().input).problem.duties);
});

test('non-weekend members are left out of the weekend rotation and never hold a cycle open', () => {
  const history = [{month: '2026-09', duties: [
    {startDate: '2026-09-04', primary: 'a'}, {startDate: '2026-09-11', primary: 'b'}, {startDate: '2026-09-07', primary: 'far'}]},
  {month: '2026-10', duties: [{startDate: '2026-10-02', primary: 'c'}, {startDate: '2026-10-05', primary: 'far'}]}];
  // With the far member counted, a/b/c all had a weekend but the cycle never closes.
  assert.deepEqual(weekendRotation(history, ['a', 'b', 'c', 'far'], '2026-11'), {a: 1, b: 1, c: 1, far: 0});
  const members = ['a', 'b', 'c', 'far'].map(id => ({id, active: true, approved: true, eligible: true, ...(id === 'far' ? {noWeekends: true} : {})}));
  const {weekendRotation: rotation, weekdayRotation: weekdays} = generationRotations(history, members, '2026-11');
  assert.deepEqual(rotation, {a: 0, b: 0, c: 0}, 'the cycle closed without the far member');
  assert.ok(Object.hasOwn(weekdays, 'far'), 'the weekday rotation still includes everyone');
});

function allocationInput(count = 12, noWeekends = ['e01']) {
  const {input, now} = monthScenario('normal', count), schedule = structuredClone(input); delete schedule.targets;
  schedule.members = schedule.members.map(m => noWeekends.includes(m.id) ? {...m, noWeekends: true} : m);
  return {schedule, now, seniority: schedule.members.map(m => m.id), events: record([], {
    operation: {kind: 'members', members: schedule.members.map(m => ({id: m.id, active: true}))},
    sourceKey: 'members', at: 1, actor: 'manager', reason: 'Reviewed fixture'}).events};
}

test('Plan the month proposes +1 Permanent for each non-weekend member, taken from the others', () => {
  const plain = proposeAllocation(allocationInput(12, [])).draft;
  for (const ids of [['e01'], ['e01', 'e05']]) {
    const input = allocationInput(12, ids), {draft} = proposeAllocation(input);
    const monthTotal = sum(canonicalDuties(input.schedule.month, input.schedule.calendar).map(d => d.units));
    assert.ok(balanced(draft));
    assert.equal(sum(Object.values(draft.targetsUnits)), monthTotal, 'the total stays the month total');
    for (const id of ids) {
      assert.deepEqual(draft.changes[id], {temporary: 0, permanent: NON_WEEKEND_UNITS});
      assert.ok(draft.hand.includes(id), 'the default is a hand change the automatic balance never moves');
      assert.equal(draft.targetsUnits[id], plain.targetsUnits[id] + NON_WEEKEND_UNITS);
    }
    // No repayment: the counterpart is permanent too, spread one step per member.
    assert.ok(draft.transfers.every(t => t.kind === 'permanent' && ids.includes(t.toId)));
    assert.equal(sum(Object.values(draft.changes).map(c => c.permanent)), 0);
    assert.ok(Object.entries(draft.changes).filter(([id]) => !ids.includes(id)).every(([, c]) => c.permanent >= -2 && !c.temporary));
    // Generate books it: a complete schedule compiles without any temporary debt.
    const assignments = solveGeneration(solver, createGenerationRequest({...input.schedule,
      targets: Object.fromEntries(Object.entries(draft.targetsUnits).map(([k, v]) => [k, v / 2]))}, {now: input.now, seed: 17, seconds: 4})).assignments;
    for (const id of ids) assert.deepEqual(weekends(input.schedule, assignments, id), []);
    assert.equal(compileAllocation(input, draft, assignments).confirmable, true);
  }
});

test('the manager can still edit the +1 that month, and an edit back to zero is kept on a fresh proposal', () => {
  const input = allocationInput(), {draft} = proposeAllocation(input);
  assert.equal(editOptions(input, draft, 2).e01.permanent.down, true);
  const removed = editAllocation(input, draft, {engineer: 'e01', deltaUnits: -NON_WEEKEND_UNITS, kind: 'permanent'}).draft;
  assert.deepEqual(removed.changes.e01, {temporary: 0, permanent: 0});
  assert.ok(balanced(removed));
  assert.deepEqual(proposeAllocation(input, retainedChanges(removed)).draft.changes.e01, {temporary: 0, permanent: 0});
  const doubled = editAllocation(input, draft, {engineer: 'e01', deltaUnits: 2, kind: 'permanent'}).draft;
  assert.deepEqual(proposeAllocation(input, retainedChanges(doubled)).draft.changes.e01, {temporary: 0, permanent: 4});
  // A plan retained from before the setting (no hand edit of e01) gains the default.
  const before = proposeAllocation(allocationInput(12, [])).draft;
  assert.deepEqual(proposeAllocation(input, retainedChanges(before)).draft.changes.e01, {temporary: 0, permanent: NON_WEEKEND_UNITS});
});

test('the default respects the month cap, availability and a counterpart; otherwise it is left out', () => {
  // Two members, one non-weekend: the default fits the cap and the other absorbs it.
  const pair = allocationInput(2, ['e00']), {draft} = proposeAllocation(pair);
  const monthTotal = sum(canonicalDuties(pair.schedule.month, pair.schedule.calendar).map(d => d.units));
  assert.ok(draft.baselineUnits.e00 + draft.changes.e00.permanent <= monthTotal);
  assert.ok(draft.changes.e00.permanent <= permanentCeiling(monthTotal, draft, 'e00'));
  // Two weekdays left = exactly the fair share: availability cannot hold one more point.
  const tight = allocationInput(12, ['e01']);
  const weekdays = canonicalDuties(tight.schedule.month, tight.schedule.calendar).filter(d => !d.weekendId);
  tight.schedule.constraints.e01 = Object.fromEntries(weekdays.slice(2).flatMap(d => d.dates.map(date => [date, 'no'])));
  const limited = proposeAllocation(tight).draft;
  assert.deepEqual(limited.changes.e01, {temporary: 0, permanent: 0});
  assert.ok(!limited.hand?.includes('e01'));
  assert.ok(balanced(limited));
  // Everyone non-weekend in a one-member month: no counterpart, so no default.
  const alone = allocationInput(1, ['e00']), single = proposeAllocation({...alone, seniority: ['e00']}).draft;
  assert.deepEqual(single.changes.e00, {temporary: 0, permanent: 0});
});

test('everyone but one, or everyone, non-weekend: the plan still balances and Generate is partial, never an error', () => {
  for (const takers of [1, 0]) {
    const ids = Array.from({length: 12}, (_, i) => `e${String(i).padStart(2, '0')}`).slice(takers);
    const input = allocationInput(12, ids), {draft} = proposeAllocation(input);
    const monthTotal = sum(canonicalDuties(input.schedule.month, input.schedule.calendar).map(d => d.units));
    assert.ok(balanced(draft), `${takers}: balanced`);
    assert.equal(sum(Object.values(draft.targetsUnits)), monthTotal, `${takers}: the total stays the month total`);
    const members = input.schedule.members.map(m => ({...m, active: true, approved: true, eligible: true}));
    assert.deepEqual(Object.keys(generationRotations([], members, input.schedule.month).weekendRotation), takers ? ['e00'] : []);
    const schedule = {...input.schedule, targets: Object.fromEntries(Object.entries(draft.targetsUnits).map(([k, v]) => [k, v / 2]))};
    const r = solveGeneration(solver, createGenerationRequest(schedule, {now: input.now, seed: 17, seconds: 4}));
    for (const id of ids) assert.deepEqual(weekends(schedule, r.assignments, id), [], `${takers}: ${id} has no weekend`);
    if (!takers) assert.equal(r.complete, false, 'no one can take the weekends: a partial draft');
  }
});

test('turning the setting off later puts the member back in the weekend rotation, due first', () => {
  // October: far was non-weekend and only took weekdays; a, b and c had weekends.
  const history = [{month: '2026-10', duties: [{startDate: '2026-10-02', primary: 'a'}, {startDate: '2026-10-09', primary: 'b'},
    {startDate: '2026-10-16', primary: 'c'}, {startDate: '2026-10-05', primary: 'far'}]}];
  const members = flag => ['a', 'b', 'c', 'far'].map(id => ({id, active: true, approved: true, eligible: true, ...(id === 'far' && flag ? {noWeekends: true} : {})}));
  assert.deepEqual(generationRotations(history, members(true), '2026-11').weekendRotation, {a: 0, b: 0, c: 0});
  // Cleared: far rejoins with no turn yet, so far is due before everyone else.
  const rejoined = generationRotations(history, members(false), '2026-11').weekendRotation;
  assert.equal(rejoined.far, 0);
  assert.ok(['a', 'b', 'c'].every(id => rejoined[id] > rejoined.far));
  // Once far has a weekend, the cycle closes for everyone.
  const after = [...history, {month: '2026-11', duties: [{startDate: '2026-11-06', primary: 'far'}]}];
  assert.deepEqual(generationRotations(after, members(false), '2026-12').weekendRotation, {a: 0, b: 0, c: 0, far: 0});
});
