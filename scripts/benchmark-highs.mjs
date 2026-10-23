import {cpus, platform, arch} from 'node:os';
import loadHighs from 'highs';
import {createHighsAdapter} from '../lib/solver-spike/highs-adapter.ts';
import {monthFixture} from '../lib/solver-spike/fixtures.ts';
import {solveProblem} from '../lib/solver-spike/model.ts';

const solver = await createHighsAdapter(loadHighs);
console.log(JSON.stringify({node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0].model,
  version: solver.version, initMs: solver.initMs, initialMemory: solver.memoryBytes}));
for (const name of ['normal', 'constrained', 'split', 'two', 'large', 'spacing']) {
  for (let repeat = 0; repeat < 3; repeat++) {
    const result = solveProblem(solver, monthFixture(name), {seed: 17, seconds: 5, nodes: 10000});
    const {stages, assignment, ...summary} = result;
    void assignment;
    console.log(JSON.stringify({name, repeat, ...summary, stages: stages.map(({name, status, objective, bound, nodes, elapsedMs, proved}) =>
      ({name, status, objective, bound, nodes, elapsedMs, proved}))}));
  }
}
