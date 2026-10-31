import test from 'node:test';
import assert from 'node:assert/strict';
import loadHighs from 'highs';
import {createHighsAdapter, canonicalDuties, coverageStart, halfUnits, handover, inputKey, weekdayRotation, weekendRotation,
  createGenerationRequest, solveGeneration, validateGeneration, prepareGeneration, acceptGeneration, createGenerationWorker} from '../lib/scheduling/index.ts';
import {solveProblem} from '../lib/scheduling/solver/model.ts';
import {monthScenario} from './fixtures/generation.mjs';

const solver = await createHighsAdapter(loadHighs);
const run = (input, extra = {}) => solveGeneration(solver, createGenerationRequest(input,
  {now: coverageStart(input.month, input.calendar) - 1, seed: 17, seconds: 3, ...extra}));
// The quality levels above the seeded tie. Below the seed the sorted-gap leximin only breaks
// ties, so a seeded solve may legitimately return another gap vector than the oracle's.
const key = m => [-m.coverage, -m.special, -m.units, -(m.gaps[0] ?? Infinity), m.rotation, m.repeats, m.weekdays, -m.preferred];
const dayOf = date => new Date(date + 'T12:00:00Z').getUTCDay();
/** Below the proved minimum gap: the fixed quality order, the seed, then only gap-count stages. */
function assertStageOrder(order) {
  const gapIndex = order.indexOf('minimum-gap');
  assert.ok(gapIndex >= 0);
  assert.deepEqual(order.slice(gapIndex, gapIndex + 6), ['minimum-gap', 'rotation', 'repeats', 'weekdays', 'preferred', 'seed']);
  assert.ok(order.slice(gapIndex + 6).every(n => n.startsWith('gap:')));
}

test('seeded ties with preserved emergency coverage retain exact integer objective verification', () => {
  const ids = Array.from({length: 6}, (_, i) => `20000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
  const input = {month: '2026-11', sourceRevision: 'captured-2', calendar: {},
    members: ids.map(id => ({id, active: true, approved: true, eligible: true})),
    targets: Object.fromEntries(ids.map((id, i) => [id, i < 4 ? 4 : 5])),
    constraints: {[ids[1]]: {'2026-11-04': 'no'}}, secondary: {'2026-11-02': ids[1]}};
  const result = run(input, {seed: 1701, seconds: 15});
  assert.equal(result.complete, true);
  assert.equal(result.assignments['2026-11-02'].secondary, ids[1]);
  assert.notEqual(result.assignments['2026-11-02'].primary, ids[1]);
  assert.ok(result.search.stages.some(s => s.name === 'seed' && s.proved));
  assert.deepEqual(validateGeneration(input, result.assignments), result.metrics);
});
const compare = (a, b) => {
  for (let k = 0; k < Math.max(a.length, b.length); k++) {
    if ((a[k] ?? -Infinity) !== (b[k] ?? -Infinity)) return (a[k] ?? -Infinity) < (b[k] ?? -Infinity) ? -1 : 1;
  }
  return 0;
};

test('canonical real calendar: Friday ownership, combined/split/special, leap day and exact units', () => {
  const december = canonicalDuties('2027-12', {}), january = canonicalDuties('2028-01', {});
  const weekend = december.at(-1);
  assert.deepEqual(weekend.dates, ['2027-12-31', '2028-01-01']);
  assert.equal(weekend.ownerMonth, '2027-12'); assert.equal(weekend.units, 2);
  assert.equal(weekend.end, handover('2028-01-02'));
  assert.equal(january[0].id, '2028-01-02');
  assert.equal(coverageStart('2028-01', {}), handover('2028-01-02') * 60000);
  // A special range over a weekend keeps it combined at 1 + extra; a hand split keeps the total, Friday first.
  const holiday = {specials: [{id: 's', start: '2027-12-31', end: '2028-01-02', extra: 2}]};
  const special = canonicalDuties('2027-12', holiday);
  assert.deepEqual(special.slice(-1).map(d => [d.id, d.units, d.weekendId, d.dates, d.specialDates]),
    [['2027-12-31', 6, '2027-12-31', ['2027-12-31', '2028-01-01'], ['2027-12-31', '2028-01-01']]]);
  assert.deepEqual(canonicalDuties('2027-12', {...holiday, splitWeekends: ['2027-12-31']}).slice(-2).map(d => [d.id, d.units]),
    [['2027-12-31', 3], ['2028-01-01', 3]]);
  assert.deepEqual(canonicalDuties('2027-12', {specials: [{id: 's', start: '2027-12-31', end: '2028-01-02', extra: 0.5}], splitWeekends: ['2027-12-31']})
    .slice(-2).map(d => d.units), [2, 1]);
  assert.deepEqual(canonicalDuties('2027-12', {specials: [{id: 's', start: '2028-01-01', end: '2028-01-02', extra: 1}]}).at(-1).units, 4);
  // A range touching only Friday, only Saturday or both: combined and hand-split totals agree.
  for (const [start, end] of [['2027-12-30', '2028-01-01'], ['2028-01-01', '2028-01-02'], ['2027-12-31', '2028-01-02']]) {
    for (const extra of [0.5, 1, 1.5, 2]) {
      const specials = [{id: 's', start, end, extra}], whole = canonicalDuties('2027-12', {specials}).at(-1);
      const halves = canonicalDuties('2027-12', {specials, splitWeekends: ['2027-12-31']}).slice(-2);
      assert.equal(whole.units, 2 + 2 * extra, `${start} +${extra}`);
      assert.deepEqual(halves.map(d => d.units), [1 + Math.ceil(extra), 1 + Math.floor(extra)], `${start} +${extra}`);
      assert.equal(halves[0].units + halves[1].units, whole.units);
    }
  }
  assert.equal(canonicalDuties('2028-02', {}).at(-1).id, '2028-02-29');
  assert.equal(canonicalDuties('2026-11', {specialDates: ['2026-11-07']}).find(d => d.id === '2026-11-06').specialDates.length, 1);
  assert.equal(halfUnits(34.5), 69);
  for (const value of [1.1, -1, Infinity, NaN, Number.MAX_SAFE_INTEGER]) assert.throws(() => halfUnits(value));
  for (const calendar of [
    {specials: [{id: 's', start: '2026-11-01', end: '2026-11-02', extra: 1.1}]},
    {specials: [{id: 's', start: '2026-11-01', end: '2026-11-20', extra: 1}]},
    {splitWeekends: ['2026-11-01']},
  ]) assert.throws(() => canonicalDuties('2026-11', calendar));
  assert.throws(() => canonicalDuties('2026-02', {specialDates: ['2026-02-30']}));
});

test('canonical calendar covers owned dates exactly once over three years, including trailing split Saturdays', () => {
  for (let year = 2026; year <= 2028; year++) for (let month = 1; month <= 12; month++) {
    const key = `${year}-${String(month).padStart(2, '0')}`;
    const ordinary = canonicalDuties(key, {});
    const split = canonicalDuties(key, {splitWeekends: ordinary.filter(d => d.weekendId).map(d => d.weekendId)});
    const dates = ordinary.flatMap(d => d.dates), splitDates = split.flatMap(d => d.dates);
    assert.deepEqual(splitDates, dates, key);
    assert.equal(new Set(dates).size, dates.length, key);
    assert.equal(split.reduce((sum, d) => sum + d.units, 0), ordinary.reduce((sum, d) => sum + d.units, 0), key);
    for (let i = 1; i < ordinary.length; i++) assert.equal(ordinary[i - 1].end, ordinary[i].start, key);
  }
});

test('Jerusalem DST handovers use 23/25 elapsed hours and correct offsets', () => {
  assert.equal(handover('2026-03-26'), Date.parse('2026-03-26T09:00:00+02:00') / 60000);
  assert.equal(handover('2026-03-27') - handover('2026-03-26'), 23 * 60);
  assert.equal(handover('2026-10-25') - handover('2026-10-24'), 25 * 60);
  assert.equal(handover('2026-10-25'), Date.parse('2026-10-25T09:00:00+02:00') / 60000);
});

test('realistic 12-engineer witnesses satisfy the independent domain validator', () => {
  for (const kind of ['normal', 'availability', 'weighted', 'locked', 'boundary', 'dst']) {
    const {input, witness} = monthScenario(kind);
    const metrics = validateGeneration(input, witness);
    assert.equal(metrics.deficits.reduce((a, b) => a + b), 0, kind);
    assert.equal(metrics.coverage, canonicalDuties(input.month, input.calendar).flatMap(d => d.dates).length);
  }
});

test('realistic ordinary and weighted 12-engineer months generate independently validated complete schedules', () => {
  for (const kind of ['normal', 'weighted']) {
    const {input} = monthScenario(kind), original = structuredClone(input);
    const r = run(input, {seconds: 10});
    assert.equal(r.complete, true, kind);
    assert.equal(r.search.allStagesProved, true, kind);
    assert.deepEqual(validateGeneration(input, r.assignments), r.metrics);
    assert.deepEqual(input, original);
  }
});

test('V1 opening equality, late acceptance, stale inputs, source revisions and frozen requests', () => {
  const {input} = monthScenario('locked'), opening = coverageStart(input.month, input.calendar);
  assert.throws(() => createGenerationRequest(input, {now: opening}), /generation-window-closed/);
  const request = createGenerationRequest(input, {now: opening - 1, seed: 17, seconds: 0});
  const result = solveGeneration(solver, request);
  assert.equal(acceptGeneration(result, input, opening - 1), result);
  assert.throws(() => acceptGeneration(result, input, opening), /generation-window-closed/);
  for (const modify of [
    i => {i.sourceRevision += '-changed';},
    i => {i.constraints.e00 = {'2026-11-01': 'no'};},
    i => {i.members[0].approved = false;},
    i => {i.calendar.specialDates = ['2026-11-01'];},
  ]) {
    const changed = structuredClone(input); modify(changed);
    assert.throws(() => acceptGeneration(result, changed, opening - 1), /stale-generation/);
  }
  input.targets.e00++;
  assert.notDeepEqual(input.targets, request.input.targets);
  assert.equal(result.completeFeasibility, 'unknown');
  assert.deepEqual(result.search.provedPrefix, []);
  assert.equal(result.search.termination, 'budget');
});

test('acceptance rejects changed assignments, metadata, proofs and reproduction settings', () => {
  const {input} = monthScenario('locked'), opening = coverageStart(input.month, input.calendar);
  const original = run(input, {seconds: 0});
  const locked = input.locks[0];
  for (const change of [
    r => {r.assignments[locked.dutyId].primary = null;},
    r => {r.metrics.coverage++;},
    r => {r.engineers[0].missingUnits++;},
    r => {r.search.allStagesProved = true;},
    r => {r.reproduction.settings.seed++;},
    r => {r.duties.reverse();},
  ]) {
    const changed = structuredClone(original); change(changed);
    assert.throws(() => acceptGeneration(changed, input, opening - 1), /altered-generation-result/);
  }
  const noLocks = limitedMonth({'2026-11-01': ['a']}, [2, 0]);
  const completeSearch = run(noLocks), changed = structuredClone(completeSearch);
  changed.assignments['2026-11-01'].primary = null;
  // Both assignments are valid partial schedules. Old optimality cannot survive.
  validateGeneration(noLocks, changed.assignments);
  assert.throws(() => acceptGeneration(changed, noLocks, opening - 1), /altered-generation-result/);
});

function limitedMonth(selected, targets, calendar = {}) {
  const month = '2026-11', duties = canonicalDuties(month, calendar);
  const members = ['a', 'b', 'c'].map(id => ({id, active: true, approved: true, eligible: true}));
  const total = duties.reduce((sum, d) => sum + d.units, 0);
  const input = {month, calendar, members, targets: {a: targets[0] / 2, b: targets[1] / 2, c: (total - targets[0] - targets[1]) / 2},
    sourceRevision: 'limited-v1', constraints: {a: {}, b: {}, c: {}}};
  for (const d of duties) for (const id of ['a', 'b', 'c']) {
    if (!(selected[d.id] ?? []).includes(id)) for (const date of d.dates) input.constraints[id][date] = 'no';
  }
  return input;
}

// Exhaustive small-case oracle: no model, domain validator, normalized candidates,
// gap helpers or comparison functions from the implementation under test.
function exhaustive(input) {
  const duties = canonicalDuties(input.month, input.calendar), candidates = duties.map(d => input.members
    .filter(e => e.active && e.approved && e.eligible && input.secondary?.[d.id] !== e.id &&
      d.dates.every(date => input.constraints?.[e.id]?.[date] !== 'no')).map(e => e.id));
  let best;
  function visit(k, selected) {
    if (k < duties.length) {
      for (const id of [null, ...candidates[k]]) visit(k + 1, [...selected, id]);
      return;
    }
    const totals = Object.fromEntries(input.members.map(e => [e.id, 0])), gaps = [];
    let coverage = 0, special = 0, preferred = 0, rotation = 0, repeats = 0, weekdays = 0;
    for (let i = 0; i < duties.length; i++) if (selected[i]) {
      totals[selected[i]] += duties[i].units; coverage += duties[i].dates.length; special += duties[i].specialDates.length;
      preferred += duties[i].dates.filter(date => input.constraints?.[selected[i]]?.[date] === 'prefer').length;
    }
    for (const e of input.members) {
      if (totals[e.id] > input.targets[e.id] * 2) return;
      const own = duties.filter((_, i) => selected[i] === e.id);
      if (new Set(own.map(d => d.weekendId).filter(Boolean)).size > 1) return;
      if (own.some(d => d.weekendId)) rotation += input.weekendRotation?.[e.id] ?? 0;
      const byWeekday = {};
      for (const d of own) if (!d.weekendId) {
        byWeekday[dayOf(d.startDate)] = (byWeekday[dayOf(d.startDate)] ?? 0) + 1;
        weekdays += input.weekdayRotation?.[e.id]?.[dayOf(d.startDate)] ?? 0;
      }
      repeats += Object.values(byWeekday).reduce((n, v) => n + Math.max(0, v - 1), 0);
      for (let j = 1; j < own.length; j++) {
        const gap = own[j].start - own[j - 1].end;
        if (gap <= 0) return;
        gaps.push(gap);
      }
    }
    const metrics = {coverage, special, units: Object.values(totals).reduce((a, b) => a + b), gaps: gaps.sort((a, b) => a - b), rotation, preferred, repeats, weekdays};
    if (!best || compare(key(metrics), key(best)) < 0) best = metrics;
  }
  visit(0, []); return best;
}

test('complete objective hierarchy agrees with independent month enumeration', () => {
  const cases = [
    limitedMonth({'2026-11-01': ['a'], '2026-11-02': ['a'], '2026-11-06': ['a'], '2026-11-09': ['a', 'b']}, [4, 4]),
    limitedMonth({'2026-11-01': ['a'], '2026-11-04': ['a', 'b'], '2026-11-09': ['a', 'b'], '2026-11-16': ['a', 'b']}, [4, 4]),
    // Two-date combined coverage beats a five-point special weekday.
    limitedMonth({'2026-11-06': ['a'], '2026-11-09': ['a']}, [10, 2],
      {specials: [{id: 's', start: '2026-11-09', end: '2026-11-10', extra: 4}]}),
    // At equal day coverage a marked split Friday beats a heavier weekday.
    limitedMonth({'2026-11-06': ['a'], '2026-11-09': ['a']}, [2, 2],
      {splitWeekends: ['2026-11-06'], specialDates: ['2026-11-06']}),
    limitedMonth({'2026-11-01': ['a', 'b'], '2026-11-04': ['a', 'b'], '2026-11-09': ['a', 'b']}, [3, 3]),
  ];
  for (const input of cases) {
    const result = run(input);
    assert.deepEqual(key(result.metrics), key(exhaustive(input)));
    assert.equal(result.search.allStagesProved, true);
    assert.equal(result.complete, false);
    assert.equal(result.completeFeasibility, 'infeasible');
    assert.deepEqual(validateGeneration(input, result.assignments), result.metrics);
    assert.equal(result.engineers.reduce((sum, e) => sum + e.missingUnits, 0), result.duties
      .filter(d => !result.assignments[d.id].primary).reduce((sum, d) => sum + d.units, 0));
  }
});

test('availability approval fixes only the reviewed duty and exact unavailable dates', () => {
  const input = limitedMonth({}, [8, 0]);
  input.locks = [{dutyId: '2026-11-06', engineer: 'a'}];
  assert.throws(() => prepareGeneration(input), /ineligible-lock/);
  input.approvals = [{rule: 'availability', dutyId: '2026-11-06', engineer: 'a', dates: ['2026-11-06', '2026-11-07'], reason: 'Reviewed cover'}];
  const result = run(input);
  assert.equal(result.assignments['2026-11-06'].primary, 'a');
  assert.equal(result.metrics.units, 2);
  assert.equal(result.engineers.find(e => e.id === 'a').lockedUnits, 2);
  input.approvals[0].dates.pop();
  assert.throws(() => prepareGeneration(input), /invalid-availability-approval/);
  input.locks = [];
  assert.throws(() => prepareGeneration(input), /invalid-availability-approval/);
});

test('fixed-pair zero remains in spacing and approvals cannot authorize new automatic adjacency', () => {
  const input = limitedMonth({'2026-11-01': ['a'], '2026-11-02': ['a'], '2026-11-03': ['a'], '2026-11-10': ['a'], '2026-11-16': ['a']}, [8, 0]);
  input.locks = ['2026-11-01', '2026-11-02'].map(dutyId => ({dutyId, engineer: 'a'}));
  assert.throws(() => prepareGeneration(input), /invalid-fixed-input/);
  input.approvals = [{rule: 'consecutive', duties: ['2026-11-01', '2026-11-02'], reason: 'Manager fixed pair'}];
  const r = run(input);
  assert.equal(r.metrics.gaps[0], 0);
  assert.equal(r.assignments['2026-11-03'].primary, null);
  assert.equal(r.assignments['2026-11-10'].primary, 'a');
  assert.equal(r.assignments['2026-11-16'].primary, 'a');
  assert.equal(r.search.allStagesProved, true);
  input.approvals.push({rule: 'consecutive', duties: ['2026-11-02', '2026-11-03'], reason: 'Too broad'});
  assert.throws(() => prepareGeneration(input), /invalid-fixed-input/);
});

test('approved locked weekends preserve only their identities; two-engineer months keep the cap', () => {
  const input = limitedMonth({'2026-11-06': ['a'], '2026-11-13': ['a'], '2026-11-20': ['a']}, [6, 0]);
  input.locks = ['2026-11-06', '2026-11-13'].map(dutyId => ({dutyId, engineer: 'a'}));
  assert.throws(() => prepareGeneration(input), /invalid-fixed-input/);
  input.approvals = [{rule: 'weekends', engineer: 'a', weekends: ['2026-11-06', '2026-11-13'], reason: 'Reviewed extra weekend'}];
  const r = run(input);
  assert.equal(r.assignments['2026-11-20'].primary, null);
  assert.equal(r.metrics.coverage, 4);
  const {input: two} = monthScenario('small-team');
  const twoResult = run(two, {seconds: 5});
  const covered = twoResult.duties.filter(d => d.weekendId && twoResult.assignments[d.id].primary);
  assert.equal(covered.length, 2);
  assert.equal(twoResult.search.provedPrefix.includes('coverage'), true);
});

test('boundary union binds both sources, deduplicates facts, protects next owner and supports scoped locks', () => {
  const input = limitedMonth({'2026-11-01': ['a', 'b'], '2026-11-30': ['a', 'b']}, [4, 4]);
  input.neighbors = [
    {id: 'live', ownerMonth: '2026-10', start: '2026-10-30', end: '2026-11-01', engineer: 'a', source: 'published'},
    {id: 'working-copy', ownerMonth: '2026-10', start: '2026-10-30', end: '2026-11-01', engineer: 'a', source: 'working'},
    {id: 'working', ownerMonth: '2026-10', start: '2026-10-31', end: '2026-11-01', engineer: 'b', source: 'working'},
    {id: 'next', ownerMonth: '2026-12', start: '2026-12-01', end: '2026-12-02', engineer: 'a', source: 'working'},
  ];
  assert.equal(prepareGeneration(input).problem.boundaries.length, 3);
  const saved = structuredClone(input.neighbors), r = run(input);
  assert.equal(r.assignments['2026-11-01'].primary, null);
  assert.equal(r.assignments['2026-11-30'].primary, 'b');
  assert.ok(r.diagnostics.some(d => d.code === 'binding-neighbor-restriction' && d.sources.some(s => s.includes('published'))));
  input.locks = [{dutyId: '2026-11-01', engineer: 'a'}];
  assert.throws(() => prepareGeneration(input), /invalid-fixed-input/);
  input.approvals = [{rule: 'boundary', dutyId: '2026-11-01', neighborId: 'live', reason: 'Reviewed adjacent commitment'}];
  assert.equal(run(input).assignments['2026-11-01'].primary, 'a');
  assert.deepEqual(input.neighbors, saved);
});

test('emergency identity excludes primary but contributes no points, gaps or weekend use', () => {
  const input = limitedMonth({'2026-11-06': ['a', 'b'], '2026-11-13': ['a']}, [2, 2]);
  input.secondary = {'2026-11-06': 'a'};
  const result = run(input);
  assert.deepEqual(result.assignments['2026-11-06'], {primary: 'b', secondary: 'a'});
  assert.equal(result.assignments['2026-11-13'].primary, 'a');
  assert.deepEqual(result.metrics.gaps, []);
  input.locks = [{dutyId: '2026-11-06', engineer: 'a'}];
  assert.throws(() => prepareGeneration(input), /ineligible-lock/);
});

test('preferred dates precede recorded seeded alternatives; reordering inputs reproduces proven schedules', t => {
  const input = limitedMonth({'2026-11-01': ['a', 'b'], '2026-11-04': ['a', 'b']}, [2, 2]);
  input.constraints.a['2026-11-01'] = 'prefer';
  const first = run(input), replay = run({...input, members: [...input.members].reverse()});
  assert.equal(first.assignments['2026-11-01'].primary, 'a');
  assert.deepEqual(first.assignments, replay.assignments);
  assert.equal(first.reproduction.inputKey, inputKey(input));
  assertStageOrder(first.search.provedPrefix);
  delete input.constraints.a['2026-11-01'];
  const signatures = new Set();
  for (let seed = 0; seed < 8; seed++) {
    const r = run(input, {seed}); signatures.add(JSON.stringify(r.assignments));
    assert.deepEqual(key({...r.metrics, preferred: 0}), key({...first.metrics, preferred: 0}));
    assert.equal(r.reproduction.settings.seed, seed);
  }
  assert.ok(signatures.size > 1);
  let draws = 0;
  t.mock.method(crypto, 'getRandomValues', array => {array[0] = ++draws; return array;});
  const requests = [createGenerationRequest(input, {now: coverageStart(input.month, {}) - 1}),
    createGenerationRequest(input, {now: coverageStart(input.month, {}) - 1})];
  assert.ok(requests.every(r => Number.isInteger(r.settings.seed) && r.settings.seed >= 0));
  assert.notEqual(requests[0].settings.seed, requests[1].settings.seed);
  assert.equal(draws, 2);
});

test('weekend rotation gives weekends to members with fewer turns, below the minimum gap and above preferences', () => {
  // One duty each: the weekend and a Monday are otherwise equivalent.
  const equal = limitedMonth({'2026-11-06': ['a', 'b'], '2026-11-16': ['a', 'b']}, [2, 2]);
  for (const [rotation, weekend] of [[{a: 1, b: 0}, 'b'], [{a: 0, b: 2}, 'a'], [{a: 3}, 'b']]) {
    const r = run({...equal, weekendRotation: rotation});
    assert.equal(r.assignments['2026-11-06'].primary, weekend);
    assert.equal(r.metrics.rotation, 0);
    assert.ok(r.search.stages.some(s => s.name === 'rotation' && s.proved));
    assert.deepEqual(key(r.metrics), key(exhaustive({...equal, weekendRotation: rotation})));
    assert.deepEqual(validateGeneration({...equal, weekendRotation: rotation}, r.assignments), r.metrics);
  }
  // Equal counts: the rotation level is an identity and the seed still varies the choice.
  const ties = new Set([0, 1, 2, 3, 4, 5].map(seed => run({...equal, weekendRotation: {a: 1, b: 1}}, {seed}).assignments['2026-11-06'].primary));
  assert.equal(ties.size, 2);
  // The minimum gap wins: giving b the weekend would leave a with a three-day gap.
  const spaced = limitedMonth({'2026-11-02': ['a'], '2026-11-06': ['a', 'b'], '2026-11-16': ['a', 'b']}, [4, 2]);
  const s = run({...spaced, weekendRotation: {a: 0, b: 1}});
  assert.equal(s.assignments['2026-11-06'].primary, 'b');
  assert.equal(s.metrics.rotation, 1);
  assert.deepEqual(s.metrics.gaps, [13 * 1440]);
  // A preferred weekend date does not outrank the rotation.
  const preferred = structuredClone(equal); preferred.constraints.a['2026-11-06'] = 'prefer';
  const p = run({...preferred, weekendRotation: {a: 1, b: 0}});
  assert.equal(p.assignments['2026-11-06'].primary, 'b');
  assert.equal(p.metrics.preferred, 0);
  assert.deepEqual(key(p.metrics), key(exhaustive({...preferred, weekendRotation: {a: 1, b: 0}})));
  assert.throws(() => prepareGeneration({...equal, weekendRotation: {zed: 1}}), /unknown-rotation-member/);
  assert.throws(() => prepareGeneration({...equal, weekendRotation: {a: -1}}), /invalid-rotation/);
  assert.throws(() => prepareGeneration({...equal, weekendRotation: {a: 0.5}}), /invalid-rotation/);
});

test('same-weekday repeats are minimized below the minimum gap, above the gap distribution and preferences', () => {
  // c alone covers four Mondays and one Tuesday: three gaps are forced, one repeat is avoidable only
  // by a shorter gap, so spacing keeps the repeat; the validator counts it independently.
  const forced = limitedMonth({'2026-11-02': ['a'], '2026-11-16': ['a']}, [4, 0]);
  const f = run(forced);
  assert.equal(f.metrics.repeats, 1);
  assert.ok(f.search.stages.some(s => s.name === 'repeats' && s.proved));
  assert.deepEqual(validateGeneration(forced, f.assignments), f.metrics);
  // With at most four Sunday–Thursday duties per engineer, equal sorted gap vectors fix the
  // repeat count (an exhaustive November search found no exception), so the level acts only on
  // heavier loads: here a (five duties) and b (two) tie on spacing with one or two repeats.
  const shared = ['2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11'];
  const tie = limitedMonth({'2026-11-01': ['a'], '2026-11-03': ['a'], '2026-11-16': ['a'], ...Object.fromEntries(shared.map(d => [d, ['a', 'b']]))}, [10, 4]);
  const t = run(tie);
  assert.deepEqual(key(t.metrics), key(exhaustive(tie)));
  assert.deepEqual(t.metrics.gaps.map(g => g / 1440), [1, 1, 1, 4, 5]);
  assert.equal(t.metrics.repeats, 1);
  assert.deepEqual(['2026-11-08', '2026-11-10'].map(d => t.assignments[d].primary), ['b', 'b']);
  // Weekday variety outranks a preferred date: a's wish for Sunday the 8th would add a repeat.
  tie.constraints.a['2026-11-08'] = 'prefer';
  const p = run(tie);
  assert.equal(p.assignments['2026-11-08'].primary, 'b');
  assert.equal(p.metrics.preferred, 0);
  assert.equal(p.metrics.repeats, 1);
  assert.deepEqual(key(p.metrics), key(exhaustive(tie)));
  // Above the gap distribution: a Tuesday seven days after the locked pair beats a Monday
  // twenty days later, because the Monday would repeat the locked Monday's weekday.
  const variety = limitedMonth({'2026-11-01': ['a'], '2026-11-02': ['a'], '2026-11-10': ['a'], '2026-11-16': ['a'], '2026-11-23': ['a']}, [6, 0]);
  variety.locks = ['2026-11-01', '2026-11-02'].map(dutyId => ({dutyId, engineer: 'a'}));
  variety.approvals = [{rule: 'consecutive', duties: ['2026-11-01', '2026-11-02'], reason: 'Reviewed fixed pair'}];
  const v = run(variety);
  assert.equal(v.assignments['2026-11-10'].primary, 'a');
  assert.deepEqual(v.metrics.gaps, [0, 7 * 1440]);
  assert.equal(v.metrics.repeats, 0); // the oracle knows no locks, so no key comparison here
  // Realistic month: no repeats remain and the minimum gap is unchanged at eleven days.
  const ordinary = run(monthScenario('normal').input, {seconds: 15});
  assert.equal(ordinary.metrics.repeats, 0);
  assert.equal(ordinary.metrics.gaps[0], 11 * 1440);
  assert.equal(ordinary.search.allStagesProved, true);
});

test('a fresh seed varies the whole month, including its gap pattern, at the proved minimum gap without repeats', () => {
  const {input} = monthScenario('normal');
  const results = Array.from({length: 12}, (_, seed) => run(input, {seed: seed + 1, seconds: 15}));
  assert.ok(results.every(r => r.complete && r.search.allStagesProved && r.search.minimumGap.proved));
  assert.ok(results.every(r => r.metrics.gaps[0] === 11 * 1440 && r.metrics.repeats === 0 && r.metrics.weekdays === 0));
  // The sorted-gap leximin sits below the seed: pairs are no longer pushed to the same
  // two-week pattern, so the gap vectors differ between seeds.
  assert.ok(new Set(results.map(r => JSON.stringify(r.metrics.gaps))).size >= results.length / 2);
  assert.equal(new Set(results.map(r => JSON.stringify(r.assignments))).size, results.length);
  for (const r of results) assertStageOrder(r.search.provedPrefix);
  const duties = results[0].duties, varied = duties.filter(d => new Set(results.map(r => r.assignments[d.id].primary)).size > 1);
  assert.ok(varied.length >= duties.length / 2, `${varied.length} of ${duties.length} duties vary`);
  assert.ok(varied.some(d => d.id < '2026-11-08') && varied.some(d => d.id > '2026-11-22'));
});

test('the minimum gap outranks preferred dates; below the seed the gap distribution only breaks ties', () => {
  const preferred = limitedMonth({'2026-11-01': ['a'], '2026-11-04': ['a'], '2026-11-09': ['a'], '2026-11-16': ['a']}, [4, 0]);
  preferred.constraints.a['2026-11-04'] = 'prefer'; preferred.constraints.a['2026-11-09'] = 'prefer';
  const r = run(preferred);
  assert.equal(r.assignments['2026-11-01'].primary, 'a');
  assert.equal(r.assignments['2026-11-16'].primary, 'a');
  // Three Tuesdays after a locked zero: no weekday repeat is at stake. A preferred date now
  // wins over a longer second gap, and without it the seed, not the gap distribution, picks
  // the Tuesday; the gap-count stages still run and prove as tie-breakers.
  const zero = limitedMonth({'2026-11-01': ['a'], '2026-11-02': ['a'], '2026-11-10': ['a'], '2026-11-17': ['a'], '2026-11-24': ['a']}, [6, 0]);
  zero.locks = ['2026-11-01', '2026-11-02'].map(dutyId => ({dutyId, engineer: 'a'}));
  zero.approvals = [{rule: 'consecutive', duties: ['2026-11-01', '2026-11-02'], reason: 'Reviewed fixed pair'}];
  zero.constraints.a['2026-11-10'] = 'prefer';
  const z = run(zero);
  assert.deepEqual(z.metrics.gaps, [0, 7 * 1440]);
  assert.equal(z.assignments['2026-11-10'].primary, 'a');
  assert.equal(z.search.allStagesProved, true);
  assert.ok(z.search.stages.some(s => s.name.startsWith('gap:') && s.proved));
  assert.ok(z.search.provedPrefix.indexOf('seed') < z.search.provedPrefix.findIndex(n => n.startsWith('gap:')));
  delete zero.constraints.a['2026-11-10'];
  const tuesdays = new Set([0, 1, 2, 3, 4, 5, 6, 7].map(seed => JSON.stringify(run(zero, {seed}).metrics.gaps)));
  assert.ok(tuesdays.size > 1);
  // Both duties on a would gain a preference, but introduce a finite gap.
  const infinite = limitedMonth({'2026-11-01': ['a', 'b'], '2026-11-04': ['a', 'b']}, [4, 2]);
  infinite.constraints.a['2026-11-01'] = 'prefer'; infinite.constraints.a['2026-11-04'] = 'prefer';
  const gapFree = run(infinite);
  assert.deepEqual(gapFree.metrics.gaps, []);
  assert.notEqual(gapFree.assignments['2026-11-01'].primary, gapFree.assignments['2026-11-04'].primary);
  assert.equal(gapFree.search.allStagesProved, true);
});

test('cross-month weekday rotation gives a weekday to whoever has not had it, below in-month variety and above preferences', () => {
  // One duty each on a Monday and a Tuesday: the member who already covered Monday this cycle takes Tuesday.
  const pair = limitedMonth({'2026-11-09': ['a', 'b'], '2026-11-10': ['a', 'b']}, [2, 2]);
  for (const [state, monday] of [[{a: [0, 1, 0, 0, 0], b: [0, 0, 1, 0, 0]}, 'b'], [{a: [0, 0, 2, 0, 0], b: [0, 1, 0, 0, 0]}, 'a'], [{b: [0, 3, 0, 0, 0]}, 'a']]) {
    const input = {...pair, weekdayRotation: state}, r = run(input);
    assert.equal(r.assignments['2026-11-09'].primary, monday);
    assert.equal(r.metrics.weekdays, 0);
    assert.ok(r.search.stages.some(s => s.name === 'weekdays' && s.proved));
    assert.deepEqual(key(r.metrics), key(exhaustive(input)));
    assert.deepEqual(validateGeneration(input, r.assignments), r.metrics);
  }
  // Equal counts: the level is an identity and the seed still varies the choice.
  const level = {a: [1, 1, 1, 1, 1], b: [1, 1, 1, 1, 1]};
  const ties = new Set([0, 1, 2, 3, 4, 5].map(seed => run({...pair, weekdayRotation: level}, {seed}).assignments['2026-11-09'].primary));
  assert.equal(ties.size, 2);
  assert.equal(run({...pair, weekdayRotation: level}).metrics.weekdays, 2);
  // A preferred date does not outrank the weekday rotation.
  const preferred = structuredClone(pair); preferred.constraints.a['2026-11-09'] = 'prefer';
  const p = run({...preferred, weekdayRotation: {a: [0, 1, 0, 0, 0]}});
  assert.equal(p.assignments['2026-11-09'].primary, 'b');
  assert.equal(p.metrics.preferred, 0);
  assert.deepEqual(key(p.metrics), key(exhaustive({...preferred, weekdayRotation: {a: [0, 1, 0, 0, 0]}})));
  // In-month variety outranks it: after a locked Sunday–Monday pair, a Monday would cost nothing
  // this cycle but repeat the weekday, so a takes the Tuesday although Tuesday is already covered.
  const locked = limitedMonth({'2026-11-01': ['a'], '2026-11-02': ['a'], '2026-11-10': ['a'], '2026-11-16': ['a'], '2026-11-23': ['a']}, [6, 0]);
  locked.locks = ['2026-11-01', '2026-11-02'].map(dutyId => ({dutyId, engineer: 'a'}));
  locked.approvals = [{rule: 'consecutive', duties: ['2026-11-01', '2026-11-02'], reason: 'Reviewed fixed pair'}];
  const v = run({...locked, weekdayRotation: {a: [0, 0, 1, 0, 0]}});
  assert.equal(v.assignments['2026-11-10'].primary, 'a');
  assert.deepEqual([v.metrics.repeats, v.metrics.weekdays], [0, 1]);
  // Among the weekdays not yet covered, the rotation decides; the remaining Tuesday tie goes to the seed.
  const open = limitedMonth({'2026-11-01': ['a'], '2026-11-02': ['a'], '2026-11-10': ['a'], '2026-11-11': ['a'], '2026-11-17': ['a']}, [6, 0]);
  open.locks = locked.locks; open.approvals = locked.approvals;
  const w = run({...open, weekdayRotation: {a: [0, 0, 0, 1, 0]}});
  assert.equal(w.assignments['2026-11-11'].primary, null);
  assert.equal(w.metrics.weekdays, 0);
  const t = run({...open, weekdayRotation: {a: [0, 0, 1, 0, 0]}});
  assert.equal(t.assignments['2026-11-11'].primary, 'a');
  assert.equal(t.metrics.weekdays, 0);
  assert.throws(() => prepareGeneration({...pair, weekdayRotation: {zed: [0, 0, 0, 0, 0]}}), /unknown-rotation-member/);
  for (const counts of [[0, 1], [0, 0, 0, 0, -1], [0, 0, 0, 0, 0.5], 3]) {
    assert.throws(() => prepareGeneration({...pair, weekdayRotation: {a: counts}}), /invalid-weekday-rotation/);
  }
});

test('over a sequence of generated months every member covers all five weekdays within one rotation cycle', () => {
  const {input: {members}} = monthScenario('normal'), ids = members.map(m => m.id), history = [];
  const month = m => {
    const duties = canonicalDuties(m, {}), base = Math.floor(duties.length / ids.length), extra = duties.length % ids.length;
    return {month: m, calendar: {}, members, sourceRevision: `sequence-${m}`, constraints: {},
      targets: Object.fromEntries(ids.map((id, i) => [id, base + (i < extra ? 1 : 0)]))};
  };
  // Cumulative Sunday–Thursday counts per member and weekday since the first generated month.
  const counts = () => Object.fromEntries(ids.map(id => [id, [0, 1, 2, 3, 4].map(wd =>
    history.reduce((n, h) => n + h.duties.filter(d => d.primary === id && dayOf(d.startDate) === wd).length, 0))]));
  const months = ['2026-11', '2026-12', '2027-01', '2027-02'];
  for (const m of months) {
    const state = weekdayRotation(history, ids, m);
    const input = {...month(m), weekendRotation: weekendRotation(history, ids, m), weekdayRotation: state};
    const r = run(input, {seed: 7, seconds: 15});
    assert.ok(r.complete && r.search.allStagesProved && r.search.minimumGap.proved, m);
    assert.equal(r.metrics.repeats, 0, m);
    assert.deepEqual(validateGeneration(input, r.assignments), r.metrics);
    // Every assigned weekday duty costs the member's current count: the level never leaves an uncovered weekday unused.
    assert.equal(r.metrics.weekdays, r.duties.reduce((n, d) => n + (d.weekendId ? 0 : state[r.assignments[d.id].primary][dayOf(d.startDate)]), 0), m);
    history.push({month: m, duties: r.duties.map(d => ({startDate: d.startDate, primary: r.assignments[d.id].primary}))});
    if (ids.every(id => counts()[id].every(n => n >= 1))) break;
  }
  // Twelve members with two or three weekday duties each need about three months for five weekdays.
  assert.ok(history.length < months.length, `the first weekday cycle completes within ${months.length - 1} generated months`);
  const cumulative = counts();
  for (const id of ids) assert.ok(cumulative[id].every(n => n >= 1), id);
  // The derived state drops every count by one once the cycle completes; extras carry over.
  assert.deepEqual(weekdayRotation(history, ids, '2027-06'), Object.fromEntries(ids.map(id => [id, cumulative[id].map(n => n - 1)])));
});

test('optional-model infeasibility contradicts its valid fallback and fails without a replacement result', () => {
  const input = limitedMonth({'2026-11-01': ['a']}, [2, 0]);
  const fake = {...solver, createSession() {
    const session = solver.createSession();
    return {...session, run() {return {status: 'infeasible', statusCode: 8, values: null,
      objective: null, bound: Infinity, gap: Infinity, nodes: 0, elapsedMs: 0, memoryBytes: 0};}};
  }};
  const request = createGenerationRequest(input, {now: coverageStart(input.month, {}) - 1, seed: 17});
  assert.throws(() => solveGeneration(fake, request), /contradicts verified incumbent/);
  assert.equal(solver.activeModels, 0);
});

test('independent validator rejects altered roles, availability, target, adjacency and canonical holes', () => {
  const {input, witness} = monthScenario();
  const result = structuredClone(witness), duties = canonicalDuties(input.month, {});
  const first = duties[0].id, second = duties[1].id;
  delete result[first]; assert.throws(() => validateGeneration(input, result));
  result[first] = {primary: 'unknown'}; assert.throws(() => validateGeneration(input, result));
  result[first] = {primary: null, secondary: 'e00'}; assert.throws(() => validateGeneration(input, result));
  result[first] = witness[first]; result[second] = witness[first]; assert.throws(() => validateGeneration(input, result));
  result[second] = witness[second]; input.constraints[witness[first].primary] = {[first]: 'no'};
  assert.throws(() => validateGeneration(input, result));
  input.targets.e00 += 0.1; assert.throws(() => prepareGeneration(input), /invalid-half-points/);
  assert.equal(solver.activeModels, 0);
});

test('Worker API returns domain progress, rejects cancellation, stale/late results, and restarts', async () => {
  const originalWorker = globalThis.Worker;
  // Exercise the real transport protocol and solver, with asynchronous delivery.
  // Actual production WASM loading/termination is covered by solver-spike.spec.ts.
  globalThis.Worker = class {
    terminated = false;
    postMessage({id, problem, settings}) {
      this.timer = setTimeout(() => {
        if (this.terminated) return;
        try {
          this.onmessage({data: {id, type: 'solving'}});
          const result = solveProblem(solver, problem, settings, progress => this.onmessage({data: {id, type: 'progress', progress}}));
          if (!this.terminated) this.onmessage({data: {id, type: 'result', result, version: solver.version, initMs: 0}});
        } catch (error) {this.onmessage({data: {id, type: 'error', message: error.message}});}
      }, 0);
    }
    terminate() {this.terminated = true; clearTimeout(this.timer);}
  };
  const input = limitedMonth({'2026-11-01': ['a'], '2026-11-04': ['b']}, [2, 2]);
  const opening = coverageStart(input.month, {}), updates = [];
  const workers = [];
  try {
    const make = (clock = () => opening - 1) => {const w = createGenerationWorker(clock); workers.push(w); return w;};
    const worker = make(), result = await worker.run(input, {seed: 17}, p => updates.push(p));
    assert.ok(updates.length > 0);
    assert.deepEqual(validateGeneration(input, updates.at(-1).assignments), updates.at(-1).metrics);
    assert.deepEqual(result.assignments, run(input).assignments);
    const cancelled = worker.run(input); worker.terminate();
    await assert.rejects(cancelled, /Worker terminated/);
    await assert.rejects(worker.run(input), /closed/);
    assert.deepEqual((await make().run(input, {seed: 17})).assignments, result.assignments);
    const mutable = structuredClone(input), stale = make().run(mutable, {seed: 17});
    mutable.sourceRevision += '-edited';
    await assert.rejects(stale, /stale-generation/);
    let reads = 0;
    await assert.rejects(make(() => reads++ === 0 ? opening - 1 : opening).run(input), /generation-window-closed/);
    await assert.rejects(make().run(input, {}, () => {throw Error('consumer callback failed');}), /consumer callback failed/);
  } finally {
    workers.forEach(w => w.terminate());
    if (originalWorker === undefined) delete globalThis.Worker; else globalThis.Worker = originalWorker;
  }
});

test('shared scarcity is a proved warning, and structural errors never become partial solver output', () => {
  const {input} = monthScenario('shared-shortage');
  const prepared = prepareGeneration(input);
  assert.ok(prepared.diagnostics.some(d => d.code === 'shared-capacity-shortage' &&
    d.engineers.includes('e00') && d.engineers.includes('e01') && d.targetUnits === 12 && d.capacityUnits === 6));
  const limited = limitedMonth({'2026-11-01': ['a']}, [0, 2]);
  limited.locks = [{dutyId: '2026-11-01', engineer: 'a'}];
  assert.throws(() => prepareGeneration(limited), /invalid-fixed-input/);
  limited.targets.a = 1;
  assert.throws(() => prepareGeneration(limited), /target-total-mismatch/);
  assert.throws(() => createGenerationRequest(input, {now: coverageStart(input.month, {}) - 1, seconds: 31}), /invalid-search-settings/);
  assert.equal(solver.activeModels, 0);
});
