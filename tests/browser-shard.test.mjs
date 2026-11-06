import test from 'node:test';
import assert from 'node:assert/strict';
import {assign, collect, shardKeys, units} from '../scripts/browser-shard.mjs';

const report = {suites: [{specs: [], suites: [{specs: [
  {file: 'a.spec.ts', line: 1, title: 'big', tests: [{projectName: 'desktop', results: [{duration: 50}]}, {projectName: 'mobile', results: [{duration: 40}]}]},
  {file: 'a.spec.ts', line: 9, title: 'small', tests: [{projectName: 'desktop', results: [{duration: 5}]}]},
  {file: 'b.spec.ts', line: 3, title: 'new test', tests: [{projectName: 'desktop', results: []}]},
]}]}]};

test('browser shards select every test line exactly once, deterministically and balanced', () => {
  const list = units(collect(report), {'a.spec.ts::big': 45, 'a.spec.ts::small': 5});
  assert.deepEqual(list.map(u => [u.key, u.ms]), [['a.spec.ts:1', 90], ['a.spec.ts:9', 5], ['b.spec.ts:3', 8000]]);
  for (const total of [1, 2, 3, 8]) {
    const shards = assign(list, total);
    assert.deepEqual(shards.flatMap(s => s.keys).sort(), list.map(u => u.key).sort());
    assert.deepEqual(assign([...list].reverse(), total), shards);
  }
  assert.deepEqual(assign(list, 2).map(s => s.keys), [['b.spec.ts:3'], ['a.spec.ts:1', 'a.spec.ts:9']]);
});

test('spec filter keeps only named files, runs every selected test once and tolerates empty shards', () => {
  const tests = collect(report);
  const weights = {'a.spec.ts::big': 45, 'a.spec.ts::small': 5};
  const specs = ['tests/browser/a.spec.ts'];
  for (const total of [1, 2, 8]) {
    const keys = Array.from({length: total}, (_, i) => shardKeys(tests, weights, i + 1, total, specs));
    assert.deepEqual(keys.flat().sort(), ['a.spec.ts:1', 'a.spec.ts:9']);
    if (total === 8) assert.equal(keys.filter(k => !k.length).length, 6, 'unused shards are empty');
  }
  const both = Array.from({length: 3}, (_, i) => shardKeys(tests, weights, i + 1, 3, ['tests/browser/b.spec.ts', ...specs]));
  assert.deepEqual(both.flat().sort(), ['a.spec.ts:1', 'a.spec.ts:9', 'b.spec.ts:3']);
  assert.deepEqual(shardKeys(tests, weights, 1, 8, ['tests/browser/missing.spec.ts']), []);
  assert.equal(Array.from({length: 2}, (_, i) => shardKeys(tests, weights, i + 1, 2)).flat().length, 3, 'no filter selects everything');
  for (const bad of ['tests/browser/*.spec.ts', '--grep=x', 'tests/browser/../x.spec.ts'])
    assert.throws(() => shardKeys(tests, weights, 1, 8, [bad]), /Invalid spec/);
});
