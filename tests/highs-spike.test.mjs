import test from 'node:test';
import assert from 'node:assert/strict';
import loadHighs from 'highs';
import {createHighsAdapter} from '../lib/solver-spike/highs-adapter.ts';
import {buildModel, solveProblem} from '../lib/solver-spike/model.ts';
import {binaryValues, checkProblem, decodeAssignment, validateAssignment} from '../lib/solver-spike/problem.ts';
import {monthFixture} from '../lib/solver-spike/fixtures.ts';

const solver = await createHighsAdapter(loadHighs);
const duty = (day, units = 2, eligible = [0, 1], extra = {}) =>
  ({start: day * 1440, end: (day + 1) * 1440, units, days: 1, special: 0, eligible, ...extra});
// Without seeded ties the seed stage is empty, so the full hierarchy ends with the sorted-gap leximin.
const key = m => [-m.coverage, -m.special, -m.units, m.extraWeekends, m.adjacent, -(m.gaps[0] ?? Infinity), m.rotation, m.repeats, m.weekdays, -m.preferred, ...m.gaps.map(g => -g)];
function compare(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? -Infinity) - (b[i] ?? -Infinity);
    if (diff) return diff;
  }
  return 0;
}
function enumerate(p) {
  let best;
  function visit(a) {
    if (a.length < p.duties.length) {
      const d = p.duties[a.length];
      for (const e of d.lock === undefined ? [null, ...d.eligible] : [d.lock]) visit([...a, e]);
      return;
    }
    try {
      const m = referenceMetrics(p, a);
      if (!best || compare(key(m), key(best)) < 0) best = m;
    } catch { /* Enumerator deliberately explores invalid assignments. */ }
  }
  visit([]); return best;
}

// Test oracle deliberately does not call the domain validator or model helpers.
function referenceMetrics(p, a) {
  const totals = p.targets.map(() => 0), gaps = [];
  let coverage = 0, special = 0, extraWeekends = 0, adjacent = 0;
  p.duties.forEach((d, i) => {
    const e = a[i];
    if (d.lock !== undefined && e !== d.lock) throw Error('lock');
    if (e === null) return;
    if (!d.eligible.includes(e)) throw Error('eligibility');
    totals[e] += d.units; coverage += d.days; special += d.special;
    for (const b of p.boundaries ?? []) {
      if (e !== b.engineer || d.end < b.start || b.end < d.start) continue;
      if (d.lock !== e || !p.exceptions?.boundary?.some(v => v.duty === i && v.boundary === b.id)) throw Error('boundary');
    }
  });
  for (let e = 0; e < totals.length; e++) {
    if (totals[e] > p.targets[e]) throw Error('ceiling');
    const indices = a.flatMap((owner, i) => owner === e ? [i] : []);
    const weekends = new Set(indices.map(i => p.duties[i].weekend).filter(w => w !== undefined));
    const approved = p.exceptions?.weekends?.find(v => v.engineer === e);
    // Extra weekends and back-to-back pairs are counted last resorts; touching duties are no gap.
    const extra = Math.max(0, weekends.size - (approved ? approved.weekends.length : 1));
    extraWeekends += extra * (extra + 1) / 2;
    for (let k = 1; k < indices.length; k++) {
      const i = indices[k - 1], j = indices[k], gap = p.duties[j].start - p.duties[i].end;
      if (gap < 0) throw Error('overlap');
      if (gap > 0) gaps.push(gap);
      else if (!p.exceptions?.consecutive?.some(([a, b]) => a === i && b === j)) adjacent++;
    }
    if (!indices.length) continue;
    const previous = (p.boundaries ?? []).filter(b => b.engineer === e && b.end <= p.duties[0].start);
    const following = (p.boundaries ?? []).filter(b => b.engineer === e && b.start >= p.duties.at(-1).end);
    const first = previous.length ? p.duties[indices[0]].start - Math.max(...previous.map(b => b.end)) : 0;
    const last = following.length ? Math.min(...following.map(b => b.start)) - p.duties[indices.at(-1)].end : 0;
    if (first > 0) gaps.push(first);
    if (last > 0) gaps.push(last);
  }
  let rotation = 0, preferred = 0, repeats = 0, weekdays = 0;
  for (let e = 0; e < totals.length; e++) {
    const indices = a.flatMap((owner, i) => owner === e ? [i] : []);
    if (indices.some(i => p.duties[i].weekend !== undefined)) rotation += p.rotation?.[e] ?? 0;
    const byWeekday = new Map();
    for (const i of indices) if (p.duties[i].weekday !== undefined) {
      byWeekday.set(p.duties[i].weekday, (byWeekday.get(p.duties[i].weekday) ?? 0) + 1);
      weekdays += p.weekdays?.[e][p.duties[i].weekday] ?? 0;
    }
    for (const n of byWeekday.values()) repeats += Math.max(0, n - 1);
    preferred += indices.reduce((n, i) => n + (p.preferences?.find(v => v.duty === i && v.engineer === e)?.weight ?? 0), 0);
  }
  return {coverage, special, units: totals.reduce((a, b) => a + b, 0),
    deficits: totals.map((v, e) => p.targets[e] - v), gaps: gaps.sort((a, b) => a - b), rotation, preferred, repeats, weekdays,
    extraWeekends, adjacent};
}

test('binary MIP, exact units, locks, eligibility, split weekend identity and partial coverage', () => {
  const cases = [
    {targets: [2, 2], duties: [duty(0), duty(2)]},
    {targets: [3, 3], duties: [duty(0, 4), duty(2, 2)]},
    {targets: [2, 2], duties: [duty(0, 2, [0]), duty(1, 2, [0])]},
    {targets: [2, 2], duties: [duty(0, 2, []), duty(2, 2, [1], {lock: 1})]},
    {targets: [2, 2], duties: [duty(0, 2, []), duty(2, 2, [])]},
    {targets: [2, 2], duties: [duty(0, 1, [0], {weekend: 0}), duty(1, 1, [1], {weekend: 0}),
      duty(7, 2, [0, 1], {weekend: 1})]},
    // Two-day ordinary coverage outranks one-day weighted special coverage.
    {targets: [2, 4], duties: [duty(0, 2, [0], {days: 2, end: 2880}), duty(3, 4, [0], {special: 1})]},
    // At equal coverage, special dates outrank weight; weight breaks the next tie.
    {targets: [4, 4], duties: [duty(0, 4, [0]), duty(2, 2, [0], {special: 1}), duty(4, 2, [0])]},
  ];
  for (const p of cases) {
    const r = solveProblem(solver, p);
    assert.deepEqual(key(r.metrics).slice(0, 3), key(enumerate(p)).slice(0, 3));
    assert.equal(r.allStagesProved, true);
    assert.deepEqual(validateAssignment(p, r.assignment), r.metrics);
    assert.equal(r.complete, r.assignment.every(e => e !== null) && r.metrics.deficits.every(n => n === 0));
    assert.equal(solver.activeModels, 0);
  }
});

test('successor-gap leximin matches independent enumeration including partial/variable-length paths', () => {
  for (const p of [
    {targets: [4, 4], duties: [0, 2, 5, 9].map(d => duty(d)), spacing: true},
    {targets: [4, 4], duties: [duty(0, 4), duty(2), duty(6)], spacing: true},
    {targets: [6, 4], duties: [duty(0), duty(2), duty(5), duty(9, 4, [])], spacing: true},
    {targets: [4, 4], duties: [duty(0, 2, [0], {lock: 0}), duty(1), duty(4), duty(9, 2, [0, 1], {lock: 1})], spacing: true},
    {targets: [2, 2], duties: [duty(0, 2, []), duty(2)], spacing: true},
  ]) {
    const r = solveProblem(solver, p);
    assert.deepEqual(key(r.metrics), key(enumerate(p)));
    assert.equal(r.allStagesProved, true);
  }
});

test('weekend rotation and same-weekday repeats break exact spacing ties and match enumeration', () => {
  // Five and two duties from seven days: two partitions share the sorted gap vector
  // [1, 1, 1, 4, 5] and differ only in repeated weekday labels (two versus one).
  const labels = [0, 2, 0, 1, 2, 3, 1];
  const p = {targets: [10, 4], spacing: true, duties: [1, 3, 8, 9, 10, 11, 16].map((d, i) => duty(d, 2, [0, 1], {weekday: labels[i]}))};
  const r = solveProblem(solver, p);
  assert.equal(r.allStagesProved, true);
  assert.equal(r.metrics.repeats, 1);
  assert.deepEqual(r.metrics.gaps.map(g => g / 1440), [1, 1, 1, 4, 5]);
  assert.deepEqual(r.assignment.slice(2, 5), [1, 0, 1]);
  assert.deepEqual(key(r.metrics), key(enumerate(p)));
  assert.deepEqual(r.metrics, referenceMetrics(p, r.assignment));
  // Rotation: the weekend goes to the engineer with fewer turns; equal turns leave it to the seed.
  const w = {targets: [2, 2], spacing: true, rotation: [1, 0], duties: [duty(0, 2, [0, 1], {weekend: 0}), duty(5, 2, [0, 1], {weekday: 2})]};
  const wr = solveProblem(solver, w);
  assert.equal(wr.assignment[0], 1);
  assert.equal(wr.metrics.rotation, 0);
  assert.deepEqual(key(wr.metrics), key(enumerate(w)));
  assert.throws(() => checkProblem({...w, rotation: [1]}));
  // Weekday rotation: each weekday goes to the engineer who has not covered it this cycle.
  const c = {targets: [2, 2], spacing: true, weekdays: [[0, 1, 0, 0, 0], [0, 0, 1, 0, 0]],
    duties: [duty(0, 2, [0, 1], {weekday: 1}), duty(3, 2, [0, 1], {weekday: 2})]};
  const cr = solveProblem(solver, c);
  assert.deepEqual(cr.assignment, [1, 0]);
  assert.deepEqual([cr.metrics.weekdays, cr.allStagesProved], [0, true]);
  assert.deepEqual(key(cr.metrics), key(enumerate(c)));
  assert.deepEqual(cr.metrics, referenceMetrics(c, cr.assignment));
  assert.ok(cr.stages.some(s => s.name === 'weekdays' && s.proved));
  assert.throws(() => checkProblem({...c, weekdays: [[0, 1, 0, 0, 0]]}));
  assert.throws(() => checkProblem({...c, weekdays: [[0, 1], [0, 0, 1, 0, 0]]}));
  assert.throws(() => checkProblem({...c, weekdays: [[0, 1, 0, 0, 0], [0, 0, -1, 0, 0]]}));
  assert.throws(() => checkProblem({...w, duties: [duty(0, 2, [0, 1], {weekend: 0, weekday: 1}), w.duties[1]]}));
  assert.throws(() => checkProblem({...w, duties: [w.duties[0], duty(5, 2, [0, 1], {weekday: 5})]}));
});

test('independent validator rejects fractional, missing, duplicate, over-target and illegal incumbents', () => {
  const p = {targets: [2, 2], duties: [duty(0), duty(1)]};
  for (const a of [[0.5, null], [0, 0], [0], [5, null]]) assert.throws(() => validateAssignment(p, a));
  assert.throws(() => decodeAssignment(p, {x_0_0: 0.5, x_1_0: 0.5}));
  assert.throws(() => decodeAssignment(p, {x_0_0: 1, x_1_0: 1}));
  assert.throws(() => binaryValues({x: NaN}));
  assert.throws(() => binaryValues({x: 0.01}));
  assert.deepEqual(binaryValues({x: 1 - 1e-10, y: -1e-12}), {x: 1, y: 0});
  assert.throws(() => checkProblem({...p, targets: [1.1, 2.9]}));
  assert.throws(() => checkProblem({...p, targets: [0, 4], duties: [duty(0, 2, [0], {lock: 0}), duty(1)]}));
});

test('bounded runs keep a verified fallback and never advance beyond unproved objectives', () => {
  const p = monthFixture('spacing');
  const noBudget = solveProblem(solver, p, {seed: 17, seconds: 0, nodes: 0});
  assert.deepEqual(noBudget.provedPrefix, []);
  assert.equal(noBudget.termination, 'budget');
  assert.equal(noBudget.complete, false);
  const limited = solveProblem(solver, p, {seed: 17, seconds: 0.02, nodes: 0});
  assert.deepEqual(validateAssignment(p, limited.assignment), limited.metrics);
  assert.ok(limited.stages.slice(0, -1).every(s => s.proved));
  assert.equal(limited.allStagesProved, false);
  const infeasible = solver.solve('Minimize\n obj: x\nSubject To\n a: x = 0\n b: x = 1\nBinary\n x\nEnd', {seed: 17, seconds: 1, nodes: 10});
  assert.equal(infeasible.status, 'infeasible');
  assert.equal(infeasible.values, null);
});

test('UNKNOWN/timeout without an incumbent retains the prior independently verified assignment', () => {
  const p = {targets: [4, 2], duties: [duty(0, 2, [0], {special: 1}), duty(2, 4, [])]};
  let calls = 0;
  let disposed = false;
  const fake = {memoryBytes: 0, activeModels: 0, modelsCreated: 0, startsSubmitted: 0, createSession() {
    return {addColumns() {}, addRows() {return 0;}, setObjective() {}, dispose() {disposed = true;}, run() {
    calls++;
    return {status: calls === 1 ? 'optimal' : 'unknown', statusCode: calls === 1 ? 7 : 15,
      values: calls === 1 ? {x_0_0: 1} : null,
      objective: calls === 1 ? -1 : null, bound: calls === 1 ? -1 : -Infinity,
      gap: calls === 1 ? 0 : Infinity, nodes: 0, elapsedMs: 0, memoryBytes: 0};
  }};}};
  const result = solveProblem(fake, p);
  assert.equal(calls, 2);
  assert.equal(disposed, true);
  assert.deepEqual(result.provedPrefix, ['coverage']);
  assert.equal(result.termination, 'unknown');
  assert.equal(result.complete, false);
  assert.deepEqual(result.assignment, [0, null]);
  assert.equal(result.allStagesProved, false);
});

test('coverage has no successor columns, native model and verified starts are reused', () => {
  const p = {targets: [4, 4], duties: [0, 2, 5, 9].map(d => duty(d)), spacing: true};
  const base = buildModel(p);
  assert.ok(base.columns.every(c => !/^(a|first|last|empty)_/.test(c.name)));
  const updates = [], result = solveProblem(solver, p, undefined, update => updates.push(update));
  assert.equal(result.modelsCreated, 1);
  assert.ok(result.startsSubmitted > 1);
  assert.ok(result.columns > result.baseColumns);
  assert.equal(result.binaryColumns, 9); // Eight assignments plus the fixed diagnostic binary.
  assert.equal(result.minimumGap.proved, true);
  assert.equal(result.allStagesProved, true);
  for (const update of updates) assert.deepEqual(validateAssignment(p, update.assignment), update.metrics);
  assert.equal(solver.activeModels, 0);
});

test('threshold UNKNOWN preserves an honest interval and never starts refinement', () => {
  // The first threshold probe (the first run without an objective) returns UNKNOWN.
  let objective = [], failed = false;
  const fake = {...solver, createSession() {
    const native = solver.createSession();
    return {...native, setObjective(terms) {objective = terms; native.setObjective(terms);}, run(settings, start) {
      if (failed || objective.length) return native.run(settings, start);
      failed = true;
      return {status: 'unknown', statusCode: 15, values: null, objective: null, bound: -Infinity,
        gap: Infinity, nodes: 0, elapsedMs: 0, memoryBytes: solver.memoryBytes};
    }};
  }};
  const r = solveProblem(fake, monthFixture('spacing'));
  assert.equal(failed, true);
  assert.equal(r.minimumGap.proved, false);
  assert.equal(r.thresholds[0].feasible, null);
  assert.equal(r.thresholds.length, 1);
  assert.equal(r.allStagesProved, false);
  // No refinement: no successor flows and no level below the minimum gap.
  assert.deepEqual(r.provedPrefix, ['coverage', 'special', 'units', 'extra-weekends', 'adjacent']);
  assert.ok(r.stages.every(s => !['rotation', 'repeats', 'seed'].includes(s.name) && !s.name.startsWith('gap:')));
  assert.equal(solver.activeModels, 0);
});

test('boundary union, fixed zero gaps, scoped weekend exceptions and partial paths match enumeration', () => {
  const boundary = (id, engineer, start, end, source = 'published') => ({id, engineer, start: start * 1440, end: end * 1440, source});
  const cases = [
    {targets: [4, 4], duties: [0, 2, 4, 7].map(d => duty(d)), boundaries: [
      boundary('old-live', 0, -3, -1), boundary('old-draft', 0, -2, 0, 'draft'),
      boundary('next', 1, 8, 10)]},
    {targets: [6, 2], duties: [duty(0, 2, [0], {lock: 0}), duty(1, 2, [0], {lock: 0}), duty(4), duty(8)],
      exceptions: {consecutive: [[0, 1]]}},
    {targets: [4, 2], duties: [duty(0, 2, [0], {lock: 0}), duty(3), duty(7)],
      boundaries: [boundary('touch', 0, -2, 0)], exceptions: {boundary: [{duty: 0, boundary: 'touch'}]}},
    {targets: [6, 0], duties: [duty(0, 2, [0], {lock: 0, weekend: 1}),
      duty(7, 2, [0], {lock: 0, weekend: 2}), duty(14, 2, [0], {weekend: 3})],
      exceptions: {weekends: [{engineer: 0, weekends: [1, 2]}]}},
    {targets: [3, 5], duties: [duty(0, 4), duty(3), duty(6)],
      boundaries: [boundary('prev', 0, -2, -1), boundary('after', 1, 8, 9)]},
    {targets: [6, 4], duties: [duty(0, 4, [0], {lock: 0}), duty(3), duty(6), duty(9)]},
    {targets: [2, 2], duties: [duty(0, 1, [0], {lock: 0, weekend: 1}),
      duty(1, 1, [0], {lock: 0, weekend: 1}), duty(3)], exceptions: {consecutive: [[0, 1]]}},
    {targets: [10000, 2], duties: [duty(0, 10000), duty(3)]},
    // Empty paths ignore external-only pairs, even when an engineer has both anchors.
    {targets: [0, 2], duties: [duty(2)], boundaries: [boundary('prev', 0, -2, 0), boundary('after', 0, 5, 6)]},
    // Exact elapsed minutes across a 25-hour duty; no 24-hour normalization.
    {targets: [4, 4], duties: [duty(0, 2, [0, 1], {end: 1500}), duty(2), duty(5), duty(8)]},
  ];
  for (const input of cases) {
    const p = {...input, spacing: true};
    checkProblem(p);
    const r = solveProblem(solver, p);
    assert.equal(r.allStagesProved, true);
    assert.deepEqual(key(r.metrics), key(enumerate(p)));
    assert.deepEqual(r.metrics, referenceMetrics(p, r.assignment));
    assert.equal(r.minimumGap.proved, true);
  }
  // The approved fixed pair costs nothing and is no spacing gap.
  const r = solveProblem(solver, {...cases[1], spacing: true});
  assert.equal(r.metrics.adjacent, 0);
  assert.equal(r.metrics.gaps[0], 6 * 1440);
  assert.ok(r.stages.some(s => s.name.startsWith('gap:') && s.proved));
});

test('Friday-owned cross-year coverage prevents a Sunday boundary handover assignment', () => {
  const minute = iso => Date.parse(iso) / 60000;
  const start = minute('2028-01-02T09:00:00+02:00');
  const p = {targets: [2, 2], spacing: true,
    duties: [duty(0), duty(2)].map(d => ({...d, start: d.start + start, end: d.end + start})),
    boundaries: [{id: 'december-weekend', engineer: 0, source: 'published',
      start: minute('2027-12-31T09:00:00+02:00'), end: start}]};
  const result = solveProblem(solver, p);
  assert.equal(result.assignment[0], 1);
  assert.equal(result.allStagesProved, true);
  assert.deepEqual(result.metrics, referenceMetrics(p, result.assignment));
});

test('invalid exception scope cannot authorize automatic adjacency or extra weekends', () => {
  const p = {targets: [4, 2], duties: [duty(0, 2, [0], {lock: 0}), duty(1), duty(3)]};
  assert.throws(() => checkProblem({...p, exceptions: {consecutive: [[0, 1]]}}));
  assert.throws(() => checkProblem({...p, duties: p.duties.map((d, i) => i === 1 ? {...d, lock: 0} : d)}));
  assert.throws(() => checkProblem({...p, exceptions: {weekends: [{engineer: 0, weekends: [0, 1]}]}}));
  const b = {id: 'live', engineer: 0, start: -1440, end: 0, source: 'published'};
  assert.throws(() => checkProblem({...p, boundaries: [b]}));
  assert.throws(() => checkProblem({...p, boundaries: [b], exceptions: {boundary: [{duty: 1, boundary: 'live'}]}}));
});

test('small varied weighted/partial/boundary instances match an independent exhaustive oracle', () => {
  for (let seed = 0; seed < 24; seed++) {
    const duties = Array.from({length: 5}, (_, i) => duty(i * 2 + i % 2, (i + seed) % 3 === 0 ? 1 : 2,
      [0, 1, 2].filter(e => (seed * 7 + i * 3 + e * 5) % 11 < 8),
      {special: (i + seed) % 4 === 0 ? 1 : 0, ...(i % 3 === 0 ? {weekend: i} : {})}));
    const total = duties.reduce((n, d) => n + d.units, 0);
    const targets = [seed % 4, Math.floor(total / 2), total - seed % 4 - Math.floor(total / 2)];
    const p = {duties, targets, spacing: true, boundaries: seed % 2 ? [
      {id: 'prior', engineer: 1, start: -2880, end: -60, source: 'draft'},
      {id: 'next', engineer: 0, start: 15000, end: 16000, source: 'published'}] : []};
    const r = solveProblem(solver, p);
    assert.equal(r.allStagesProved, true, `seed ${seed}`);
    assert.deepEqual(key(r.metrics), key(enumerate(p)), `seed ${seed}`);
    assert.deepEqual(r.metrics, referenceMetrics(p, r.assignment));
  }
});

test('repeatable seeded solves and disposal on both success and parser errors', () => {
  const p = monthFixture();
  const a = solveProblem(solver, p), b = solveProblem(solver, p);
  assert.deepEqual(a.assignment, b.assignment);
  assert.deepEqual(a.metrics, b.metrics);
  const before = solver.memoryBytes;
  for (let i = 0; i < 12; i++) {
    assert.throws(() => solver.solve('Minimize\n obj: x\nSubject To\n bad: x <= nope\nEnd', {seed: 17, seconds: 1, nodes: 10}));
    assert.equal(solver.activeModels, 0);
  }
  assert.ok(solver.memoryBytes <= before + 65536, 'repeated failure must not grow linear memory');
});
