import {cpus, platform, arch} from 'node:os';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {dirname, join, resolve, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import loadHighs from 'highs';
import {createHighsAdapter} from '../lib/solver-spike/highs-adapter.ts';
import {benchmarkFixture} from '../lib/solver-spike/fixtures.ts';
import {solveProblem} from '../lib/solver-spike/model.ts';
import {validateAssignment} from '../lib/solver-spike/problem.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baselineRef = '22f6d0e3a5595b76538fbe9348cc3126822e4f1b';
const args = Object.fromEntries(process.argv.slice(2).map(s => s.replace(/^--/, '').split('=')));
if (args.child) {
  const old = args.engine === 'old';
  const implementation = old ? await import(pathToFileURL(join(args.baseline, 'model.ts')).href) : {solveProblem};
  const adapter = old ? await import(pathToFileURL(join(args.baseline, 'highs-adapter.ts')).href) : {createHighsAdapter};
  const solver = await adapter.createHighsAdapter(loadHighs);
  const p = benchmarkFixture(args.fixture), settings = {seed: 17, seconds: Number(args.seconds), nodes: Number(args.nodes)};
  for (let repeat = 0; repeat < Number(args.repeat); repeat++) {
    const r = implementation.solveProblem(solver, p, settings);
    const checked = validateAssignment(p, r.assignment);
    if (JSON.stringify(checked) !== JSON.stringify(r.metrics)) throw Error('Independent benchmark validation mismatch');
    const {assignment, ...summary} = r; void assignment;
    console.log(JSON.stringify({engine: args.engine, fixture: args.fixture, repeat, settings,
      fixtureSha256: createHash('sha256').update(JSON.stringify(p)).digest('hex'),
      initMs: solver.initMs, version: solver.version,
      binaryColumns: old ? r.columns : r.binaryColumns,
      modelsCreated: old ? r.stages.length : r.modelsCreated, startsSubmitted: old ? 0 : r.startsSubmitted,
      ...summary}));
  }
} else {
  const seconds = (args.seconds ?? '5,30').split(',').map(Number), repeat = Number(args.repeat ?? 3), nodes = Number(args.nodes ?? 1000000);
  const fixtures = (args.fixtures ?? 'normal,spacing,partial-spacing,split-spacing,boundary-spacing,locked-zero').split(',');
  const engines = (args.engines ?? 'old,new').split(',');
  if (!seconds.every(n => Number.isFinite(n) && n > 0) || !Number.isInteger(repeat) || repeat < 1 || !Number.isInteger(nodes) || nodes < 0) throw Error('Invalid benchmark budget');
  const work = join(root, 'work'); mkdirSync(work, {recursive: true});
  const baseline = mkdtempSync(join(work, 'highs-baseline-'));
  try {
    writeFileSync(join(baseline, 'package.json'), JSON.stringify({type: 'module'}));
    for (const name of ['model.ts', 'problem.ts', 'highs-adapter.ts']) writeFileSync(join(baseline, name),
      execFileSync('git', ['show', `${baselineRef}:lib/solver-spike/${name}`], {cwd: root}));
    console.log(JSON.stringify({node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0].model,
      baselineRef, repeat, nodes, seconds, fixtures, isolation: 'one sequential child per engine/fixture/budget; warm repeats share only that instance'}));
    for (const fixture of fixtures) for (const budget of seconds) for (const engine of engines) {
      if (!['old', 'new'].includes(engine)) throw Error(`Unknown engine ${engine}`);
      if (engine === 'old' && ['boundary-spacing', 'locked-zero'].includes(fixture)) {
        console.log(JSON.stringify({engine, fixture, seconds: budget, unsupported: 'Original spike has no boundary anchors or scoped exceptions'}));
        continue;
      }
      const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child=1', `--engine=${engine}`,
        `--baseline=${baseline}`, `--fixture=${fixture}`, `--seconds=${budget}`, `--nodes=${nodes}`, `--repeat=${repeat}`],
        {cwd: root, encoding: 'utf8', timeout: (budget + 30) * 1000 * repeat, maxBuffer: 8 * 1024 * 1024});
      process.stdout.write(child.stdout ?? ''); process.stderr.write(child.stderr ?? '');
      if (child.error) throw child.error;
      if (child.status !== 0) throw Error(`Benchmark failed: ${engine}/${fixture}: ${child.status}`);
    }
  } finally {
    // Delete only the absolute temporary directory created by this invocation.
    if (!resolve(baseline).startsWith(resolve(work) + sep)) throw Error('Unsafe cleanup path');
    rmSync(baseline, {recursive: true, force: true});
  }
}
