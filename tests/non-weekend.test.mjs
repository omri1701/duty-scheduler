import test from 'node:test';
import assert from 'node:assert/strict';
import loadHighs from 'highs';
import {createHighsAdapter, canonicalDuties, coverageStart, createGenerationRequest, solveGeneration, validateGeneration,
  prepareGeneration, generationRotations, weekendRotation} from '../lib/scheduling/index.ts';
import {requireWeekendEligibility} from '../lib/scheduling/validate.ts';
import {record} from '../lib/compensation/index.ts';
import {proposeAllocation, editAllocation, compileAllocation, retainedChanges, balanced, editOptions, allocationDivisible} from '../lib/allocation/index.ts';
import {NON_WEEKEND_UNITS, nonWeekendLeftOut, nonWeekendOrder} from '../lib/allocation/planner.ts';
import {partitionableWeekends} from '../lib/allocation/fit.ts';
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

function allocationInput(count = 12, noWeekends = ['e01'], kind = 'normal') {
  const {input, now} = monthScenario(kind, count), schedule = structuredClone(input); delete schedule.targets;
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

test('turning the setting off rejoins the weekend rotation level, like a new member, mid-cycle or at a boundary', () => {
  const members = (flag, from) => ['a', 'b', 'c', 'far'].map(id => ({id, active: true, approved: true, eligible: true,
    ...(id === 'far' ? {...(flag ? {noWeekends: true} : {}), ...(from ? {weekendsFrom: from} : {})} : {})}));
  const rotation = (history, flag, from, month = '2026-11') => generationRotations(history, members(flag, from), month).weekendRotation;
  // Mid-cycle: in October a and b had weekends, c has not yet; far, non-weekend, took weekdays only.
  const mid = [{month: '2026-10', duties: [{startDate: '2026-10-02', primary: 'a'}, {startDate: '2026-10-09', primary: 'b'},
    {startDate: '2026-10-05', primary: 'far'}, {startDate: '2026-10-06', primary: 'c'}]}];
  assert.deepEqual(rotation(mid, true), {a: 1, b: 1, c: 0});
  // Cleared for November: far is level with those who had their turn, never ahead of c.
  assert.deepEqual(rotation(mid, false, '2026-11'), {a: 1, b: 1, c: 0, far: 1});
  // Without the rejoin month, far's weekday-only October would make far due first (the old rule).
  assert.deepEqual(rotation(mid, false), {a: 1, b: 1, c: 0, far: 0});
  // A new member with no duty at all counts the same way.
  assert.deepEqual(generationRotations(mid, [...members(true), {id: 'new', active: true, approved: true, eligible: true}], '2026-11').weekendRotation,
    {a: 1, b: 1, c: 0, new: 1});
  // At a cycle boundary (a, b and c all had one: the cycle closed), far starts level at zero.
  const boundary = [{month: '2026-10', duties: [{startDate: '2026-10-02', primary: 'a'}, {startDate: '2026-10-09', primary: 'b'},
    {startDate: '2026-10-16', primary: 'c'}, {startDate: '2026-10-05', primary: 'far'}]}];
  assert.deepEqual(rotation(boundary, false, '2026-11'), {a: 0, b: 0, c: 0, far: 0});
  // Weekends far takes from the rejoin month on count as usual: November's weekend closes far's turn.
  const after = [...mid, {month: '2026-11', duties: [{startDate: '2026-11-06', primary: 'far'}, {startDate: '2026-11-13', primary: 'c'}]}];
  assert.deepEqual(rotation(after, false, '2026-11', '2026-12'), {a: 0, b: 0, c: 0, far: 0});
  // Weekend turns from before the setting don't count either: far is new to this cycle.
  const earlier = [{month: '2026-08', duties: [{startDate: '2026-08-07', primary: 'far'}]}, ...mid];
  assert.deepEqual(rotation(earlier, false, '2026-11'), {a: 1, b: 1, c: 0, far: 1});
  assert.throws(() => prepareGeneration({...generationInput(), members: generationInput().members.map((m, i) => i ? m : {...m, weekendsFrom: '2026-13'})}), /invalid-member/);
});

// Few weekend members (decision 2026-11-05): only the weekend members fund the +1, never below
// the month's weekends; the newest non-weekend members get it first, the rest none this month.
const ids12 = Array.from({length: 12}, (_, i) => `e${String(i).padStart(2, '0')}`);
const fewTakers = (k, month = '2026-11', kind = 'normal', count = 12) => {
  const input = allocationInput(count, ids12.slice(count - k, count), kind);
  if (month !== input.schedule.month) {input.schedule.month = month; input.schedule.constraints = {};}
  return input;
};
const weekendUnits = input => canonicalDuties(input.schedule.month, input.schedule.calendar).filter(d => d.weekendId).map(d => d.units);
function assertWeekendsFunded(input, draft, label) {
  const nw = new Set(input.schedule.members.filter(m => m.noWeekends).map(m => m.id)), takers = input.seniority.filter(id => !nw.has(id));
  const free = weekendUnits(input).sort((a, b) => b - a);
  for (const id of nw) assert.ok(draft.changes[id].permanent >= 0, `${label}: ${id} never funds a +1`);
  assert.ok(sum(takers.map(id => draft.targetsUnits[id])) >= sum(free), `${label}: the weekend members can still take every weekend`);
  const rooms = takers.map(id => draft.targetsUnits[id]).sort((a, b) => b - a);
  free.slice(0, takers.length).forEach((w, k) => assert.ok(rooms[k] >= w, `${label}: one weekend each, heaviest first`));
  assert.ok(balanced(draft), `${label}: balanced`);
  assert.equal(allocationDivisible(input, draft.targetsUnits), true, `${label}: Generate can book every point`);
}

test('12 members, 10 non-weekend: the two weekend members keep their weekends and no one is cut to fund the +1', () => {
  const input = fewTakers(10), {draft} = proposeAllocation(input), plain = proposeAllocation(allocationInput(12, [])).draft;
  assertWeekendsFunded(input, draft, '10 of 12');
  // The two weekend members already carry exactly the four weekends: nothing is left to give.
  assert.deepEqual(draft.targetsUnits, plain.targetsUnits);
  assert.deepEqual(nonWeekendLeftOut(input, draft), ids12.slice(2));
  // Generate books every planned point: no "2 scheduled, plan says 3".
  const schedule = {...input.schedule, targets: Object.fromEntries(Object.entries(draft.targetsUnits).map(([k, v]) => [k, v / 2]))};
  const r = solveGeneration(solver, createGenerationRequest(schedule, {now: input.now, seed: 17, seconds: 4}));
  assert.equal(r.complete, true);
  for (const id of ids12.slice(2)) assert.deepEqual(weekends(schedule, r.assignments, id), []);
  assert.equal(compileAllocation(input, draft, r.assignments).confirmable, true);
  // A manager can still give a non-weekend member +1 by hand; the weekend members are not cut for it.
  const edited = editAllocation(input, draft, {engineer: 'e05', deltaUnits: 2, kind: 'permanent'}).draft;
  assert.deepEqual(['e00', 'e01'].map(id => edited.targetsUnits[id]), ['e00', 'e01'].map(id => draft.targetsUnits[id]));
});

test('when only some fit, +1 goes to as many as the weekend members can fund, newest non-weekend members first', () => {
  const nw = ids12.slice(4);
  for (const month of ['2026-11', '2026-12', '2027-01', '2027-02', '2027-03']) {
    const input = fewTakers(8, month), {draft} = proposeAllocation(input);
    assertWeekendsFunded(input, draft, month);
    const plus = nw.filter(id => draft.changes[id].permanent === NON_WEEKEND_UNITS);
    assert.ok(plus.length > 0 && plus.length < 8, `${month}: some, not all`);
    // The newest get it: whoever has it is newer than everyone left out.
    assert.deepEqual(plus, nw.slice(nw.length - plus.length), `${month}: newest first`);
    assert.deepEqual(nonWeekendLeftOut(input, draft), nw.filter(id => !plus.includes(id)), `${month}: the rest are explained`);
  }
  assert.deepEqual(nonWeekendOrder(fewTakers(8, '2026-11')), [...nw].reverse());
  // The user's case, by name: Tamar joined after Maya, so Tamar gets the +1 before Maya.
  const input = fewTakers(8), {draft} = proposeAllocation(input), plus = nw.filter(id => draft.changes[id].permanent === NON_WEEKEND_UNITS);
  const maya = nw[nw.length - plus.length - 1], tamar = nw[nw.length - plus.length];
  assert.equal(draft.changes[tamar].permanent, NON_WEEKEND_UNITS);
  assert.equal(draft.changes[maya].permanent, 0);
});

test('Reset is the first-opening plan: it drops kept +1s and hand edits that re-plan keeps', () => {
  // Saved with e06..e11 on +1 and a hand edit on e00; then e11 takes weekends again.
  const nov = fewTakers(6), saved = editAllocation(nov, proposeAllocation(nov).draft, {engineer: 'e00', deltaUnits: -2, kind: 'temporary'}).draft;
  const now = allocationInput(12, ids12.slice(6, 11)), replanned = proposeAllocation(now, retainedChanges(saved)).draft;
  assert.equal(replanned.changes.e11.permanent, NON_WEEKEND_UNITS, 're-plan keeps the old +1 as a hand change');
  assert.equal(replanned.changes.e00.temporary, -2, 're-plan keeps the hand edit');
  const reset = proposeAllocation(now).draft;
  // e11 is a weekend member again: no +1, and like the others it may fund the +1s.
  assert.ok(reset.changes.e11.permanent <= 0, 'reset recomputes the +1 for the current settings');
  assert.ok(!reset.hand.includes('e11') && !reset.hand.includes('e00'), 'no hand edits survive');
  assert.deepEqual(reset.pairs, []);
  assert.deepEqual(reset.hand, ids12.slice(6, 11).filter(id => reset.changes[id].permanent === NON_WEEKEND_UNITS));
  // The same as opening the month for the first time, and stable when pressed again.
  assert.deepEqual(reset, proposeAllocation(structuredClone(now)).draft);
  assertWeekendsFunded(now, reset, 'reset');
});

test('ordinary teams keep the +1, and a holiday weekend never strands it on the only member who can hold it', () => {
  for (const k of [1, 2, 3]) {
    const input = fewTakers(k), {draft} = proposeAllocation(input);
    for (const id of ids12.slice(12 - k)) assert.equal(draft.changes[id].permanent, NON_WEEKEND_UNITS, `${k}: ${id} keeps +1`);
    assert.deepEqual(draft.hand, ids12.slice(12 - k), `${k}: hand in seniority order`);
    assertWeekendsFunded(input, draft, `${k} non-weekend`);
  }
  // December 2027 has a 5-point holiday weekend: only one weekend member can hold it.
  const input = fewTakers(1, '2027-12', 'weighted', 8), {draft} = proposeAllocation(input);
  assert.equal(draft.changes.e07.permanent, NON_WEEKEND_UNITS);
  assertWeekendsFunded(input, draft, 'holiday weekend');
});

test('the weekend-aware split: weekends only for weekend members, and plain weights when no one skips them', () => {
  assert.equal(partitionableWeekends([2, 2], [2, 2], [[], []], [4, 4], [false, false]), true);
  assert.equal(partitionableWeekends([2, 2], [2, 2], [[], []], [6, 2], [true, false]), false, 'the non-weekend member needs a weekend');
  assert.equal(partitionableWeekends([2, 2], [2, 2], [[], []], [4, 4], [true, false]), true);
  assert.equal(partitionableWeekends([2, 2], [2], [[], []], [4, 2], [true, true]), false, 'no one to take the weekend');
  assert.equal(partitionableWeekends([2, 2], [], [[], []], [2, 2], [true, true]), true);
  assert.equal(partitionableWeekends([2], [1, 1], [[2], []], [4, 2], [true, false]), true, 'a locked weekend stays with its member');
});

test('re-planning after the setting changes keeps the weekend members funded', () => {
  const nov = fewTakers(8), first = proposeAllocation(nov).draft;
  assert.deepEqual(proposeAllocation(nov, retainedChanges(first)).draft, first, 'the same month re-plans the same');
  // A member with the +1 takes weekends again; a weekend member stops.
  for (const flags of [ids12.slice(4).filter(id => id !== 'e06'), [...ids12.slice(4), 'e00']]) {
    const input = allocationInput(12, flags), draft = proposeAllocation(input, retainedChanges(first)).draft;
    const nw = new Set(flags);
    for (const id of nw) assert.ok(draft.changes[id].permanent >= 0);
    assert.ok(sum(input.seniority.filter(id => !nw.has(id)).map(id => draft.targetsUnits[id])) >= sum(weekendUnits(input)));
    assert.equal(allocationDivisible(input, draft.targetsUnits), true);
  }
  // The next month starts fresh from its own rotation, and going back gives November's plan again.
  assertWeekendsFunded(fewTakers(8, '2026-12'), proposeAllocation(fewTakers(8, '2026-12')).draft, 'December');
  assert.deepEqual(proposeAllocation(fewTakers(8)).draft, first);
});
