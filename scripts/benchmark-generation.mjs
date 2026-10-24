import {cpus, platform, arch} from 'node:os';
import {writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import loadHighs from 'highs';
import {createHighsAdapter, createGenerationRequest, solveGeneration, validateGeneration} from '../lib/scheduling/index.ts';
import {monthScenario} from '../tests/fixtures/generation.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')));
const seconds = Number(args.seconds ?? 30), repeat = Number(args.repeat ?? 1);
if (!Number.isInteger(repeat) || repeat < 1) throw Error('Invalid repeat count');
const scenarios = (args.scenarios ?? 'normal,availability,weighted,locked,boundary,tight,shared-shortage,small-team,larger-team').split(',');
const rows = [], emit = row => {rows.push(JSON.stringify(row)); if (!args.quiet) console.log(rows.at(-1));};
emit({node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0].model,
  seconds, repeat, isolation: 'sequential scenarios; one fresh WASM instance per scenario, warm repeats'});
for (const kind of scenarios) {
  const {input, now} = monthScenario(kind, kind === 'larger-team' ? 24 : 12);
  const adapter = await createHighsAdapter(loadHighs);
  for (let n = 0; n < repeat; n++) {
    const started = performance.now();
    const request = createGenerationRequest(input, {now, seed: 17, seconds});
    const result = solveGeneration(adapter, request);
    const checked = validateGeneration(input, result.assignments);
    if (JSON.stringify(checked) !== JSON.stringify(result.metrics)) throw Error('Benchmark validation mismatch');
    emit({scenario: kind, engineers: input.members.length, month: input.month, repeat: n,
      inputSha256: createHash('sha256').update(request.inputKey).digest('hex'), settings: request.settings,
      version: adapter.version, initMs: adapter.initMs, totalMs: performance.now() - started,
      solveMs: result.search.elapsedMs, complete: result.complete, completeFeasibility: result.completeFeasibility,
      allStagesProved: result.search.allStagesProved, termination: result.search.termination,
      provedPrefix: result.search.provedPrefix, metrics: result.metrics, uncoveredDates: result.uncoveredDates,
      stages: result.search.stages.map(s => ({name: s.name, status: s.status, proved: s.proved, elapsedMs: s.elapsedMs,
        objective: Number.isFinite(s.objective) ? s.objective : null, bound: Number.isFinite(s.bound) ? s.bound : null, nodes: s.nodes})),
      minimumGap: result.search.minimumGap, columns: result.search.columns, rows: result.search.rows,
      memoryBytes: adapter.memoryBytes, activeModels: adapter.activeModels, independentValidation: 'passed'});
  }
}
if (args.output) writeFileSync(args.output, rows.join('\n') + '\n');
