import test from 'node:test';
import assert from 'node:assert/strict';
import loadHighs from 'highs';
import {createHighsAdapter} from '../lib/solver-spike/highs-adapter.ts';
import {solveProblem} from '../lib/solver-spike/model.ts';
import {binaryValues, checkProblem, decodeAssignment, validateAssignment} from '../lib/solver-spike/problem.ts';
import {monthFixture} from '../lib/solver-spike/fixtures.ts';

const solver = await createHighsAdapter(loadHighs);
const duty = (day, units = 2, eligible = [0, 1], extra = {}) =>
  ({start: day * 1440, end: (day + 1) * 1440, units, days: 1, special: 0, eligible, ...extra});
const key = m => [-m.coverage, -m.special, -m.units, ...m.gaps.map(g => -g)];
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
      const m = validateAssignment(p, a);
      if (!best || compare(key(m), key(best)) < 0) best = m;
    } catch { /* Enumerator deliberately explores invalid assignments. */ }
  }
  visit([]); return best;
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
  const p = {targets: [2, 2], duties: [duty(0), duty(2)]};
  let calls = 0;
  const fake = {memoryBytes: 0, activeModels: 0, solve() {
    calls++;
    return {status: calls === 1 ? 'optimal' : 'unknown', statusCode: calls === 1 ? 7 : 15,
      values: calls === 1 ? {x_0_0: 1, x_1_0: 0, x_0_1: 0, x_1_1: 1} : null,
      objective: calls === 1 ? -2 : null, bound: calls === 1 ? -2 : -Infinity,
      gap: calls === 1 ? 0 : Infinity, nodes: 0, elapsedMs: 0, memoryBytes: 0};
  }};
  const result = solveProblem(fake, p);
  assert.equal(calls, 2);
  assert.deepEqual(result.provedPrefix, ['coverage']);
  assert.equal(result.termination, 'unknown');
  assert.equal(result.complete, true);
  assert.deepEqual(result.assignment, [0, 1]);
  assert.equal(result.allStagesProved, false);
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
