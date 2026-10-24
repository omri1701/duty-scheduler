import test from 'node:test';
import assert from 'node:assert/strict';
import loadHighs from 'highs';
import {createHighsAdapter, canonicalDuties, coverageStart, halfUnits, handover, inputKey,
  createGenerationRequest, solveGeneration, validateGeneration, prepareGeneration, acceptGeneration, createGenerationWorker} from '../lib/scheduling/index.ts';
import {solveProblem} from '../lib/scheduling/solver/model.ts';
import {monthScenario} from './fixtures/generation.mjs';

const solver = await createHighsAdapter(loadHighs);
const run = (input, extra = {}) => solveGeneration(solver, createGenerationRequest(input,
  {now: coverageStart(input.month, input.calendar) - 1, seed: 17, seconds: 3, ...extra}));
const key = m => [-m.coverage, -m.special, -m.units, ...m.gaps.map(g => -g)];

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
  const special = canonicalDuties('2027-12', {specials: [{id: 's', start: '2027-12-31', end: '2028-01-02', extra: 2}]});
  assert.deepEqual(special.slice(-2).map(d => [d.id, d.units, d.weekendId]), [
    ['2027-12-31', 5, '2027-12-31'], ['2028-01-01', 5, '2027-12-31']]);
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
    let coverage = 0, special = 0;
    for (let i = 0; i < duties.length; i++) if (selected[i]) {
      totals[selected[i]] += duties[i].units; coverage += duties[i].dates.length; special += duties[i].specialDates.length;
    }
    for (const e of input.members) {
      if (totals[e.id] > input.targets[e.id] * 2) return;
      const own = duties.filter((_, i) => selected[i] === e.id);
      if (new Set(own.map(d => d.weekendId).filter(Boolean)).size > 1) return;
      for (let j = 1; j < own.length; j++) {
        const gap = own[j].start - own[j - 1].end;
        if (gap <= 0) return;
        gaps.push(gap);
      }
    }
    const metrics = {coverage, special, units: Object.values(totals).reduce((a, b) => a + b), gaps: gaps.sort((a, b) => a - b)};
    if (!best || compare(key(metrics), key(best)) < 0) best = metrics;
  }
  visit(0, []); return best;
}

test('complete objective hierarchy and full variable-length leximin agree with independent month enumeration', () => {
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
  assert.deepEqual(first.search.provedPrefix.slice(-2), ['preferred', 'seed']);
  delete input.constraints.a['2026-11-01'];
  const signatures = new Set();
  for (let seed = 0; seed < 8; seed++) {
    const r = run(input, {seed}); signatures.add(JSON.stringify(r.assignments));
    assert.deepEqual(key(r.metrics), key(first.metrics));
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

test('spacing outranks preferred dates and a locked zero cannot hide the next-worst gap', () => {
  const preferred = limitedMonth({'2026-11-01': ['a'], '2026-11-04': ['a'], '2026-11-09': ['a'], '2026-11-16': ['a']}, [4, 0]);
  preferred.constraints.a['2026-11-04'] = 'prefer'; preferred.constraints.a['2026-11-09'] = 'prefer';
  const r = run(preferred);
  assert.equal(r.assignments['2026-11-01'].primary, 'a');
  assert.equal(r.assignments['2026-11-16'].primary, 'a');
  const zero = limitedMonth({'2026-11-01': ['a'], '2026-11-02': ['a'], '2026-11-10': ['a'], '2026-11-16': ['a'], '2026-11-23': ['a']}, [6, 0]);
  zero.locks = ['2026-11-01', '2026-11-02'].map(dutyId => ({dutyId, engineer: 'a'}));
  zero.approvals = [{rule: 'consecutive', duties: ['2026-11-01', '2026-11-02'], reason: 'Reviewed fixed pair'}];
  zero.constraints.a['2026-11-10'] = 'prefer';
  const z = run(zero);
  assert.deepEqual(z.metrics.gaps, [0, 20 * 1440]);
  assert.equal(z.assignments['2026-11-23'].primary, 'a');
  assert.equal(z.search.allStagesProved, true);
  // Both duties on a would gain a preference, but introduce a finite gap.
  const infinite = limitedMonth({'2026-11-01': ['a', 'b'], '2026-11-04': ['a', 'b']}, [4, 2]);
  infinite.constraints.a['2026-11-01'] = 'prefer'; infinite.constraints.a['2026-11-04'] = 'prefer';
  const gapFree = run(infinite);
  assert.deepEqual(gapFree.metrics.gaps, []);
  assert.notEqual(gapFree.assignments['2026-11-01'].primary, gapFree.assignments['2026-11-04'].primary);
  assert.equal(gapFree.search.allStagesProved, true);
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
