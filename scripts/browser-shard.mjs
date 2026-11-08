// Deterministic, duration-balanced browser shards. Playwright's own --shard keeps heavy
// spec files together, so CI selects tests by file:line instead (every line goes to
// exactly one shard). Usage: node scripts/browser-shard.mjs <shard> <total> [tests/browser/x.spec.ts ...]
//        (optional spec files limit the run to those files; output is empty for an empty shard)
//        node scripts/browser-shard.mjs --update <playwright-json-report>   (refresh weights)
import {spawnSync} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const weightsPath = fileURLToPath(new URL('../tests/browser/shard-weights.json', import.meta.url));
const DEFAULT_MS = 8000; // Tests without a recorded duration (new or renamed) count as typical.

export function collect(report) {
  const tests = [];
  const walk = suite => {
    for (const spec of suite.specs ?? []) for (const test of spec.tests ?? []) {
      const ms = (test.results ?? []).reduce((sum, result) => sum + result.duration, 0);
      tests.push({file: spec.file, line: spec.line, title: spec.title, project: test.projectName, ms});
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites ?? []) walk(suite);
  return tests;
}

// One unit per source line (all projects of that test run together); weights keyed by file::title.
export function units(tests, weights) {
  const byLine = new Map();
  for (const test of tests) {
    const key = `${test.file}:${test.line}`;
    const unit = byLine.get(key) ?? {key, file: test.file, line: test.line, ms: 0};
    unit.ms += weights[`${test.file}::${test.title}`] ?? DEFAULT_MS;
    byLine.set(key, unit);
  }
  return [...byLine.values()];
}

// Longest-processing-time first onto the lightest shard; ties break by key, so it is deterministic.
export function assign(list, total) {
  const shards = Array.from({length: total}, () => ({ms: 0, keys: []}));
  for (const unit of [...list].sort((a, b) => b.ms - a.ms || (a.key < b.key ? -1 : 1))) {
    const lightest = shards.reduce((best, shard) => (shard.ms < best.ms ? shard : best));
    lightest.ms += unit.ms; lightest.keys.push(unit.key);
  }
  return shards;
}

const SPEC = /^tests\/browser\/[A-Za-z0-9_-]+\.spec\.ts$/;

// Keys (file:line) of one shard. With a spec filter only those files take part, still balanced
// by duration across all shards; a shard may end up empty.
export function shardKeys(tests, weights, shard, total, specs = []) {
  for (const spec of specs) if (!SPEC.test(spec)) throw Error(`Invalid spec path: ${spec}`);
  const wanted = new Set(specs);
  const scoped = wanted.size ? tests.filter(test => wanted.has(`tests/browser/${test.file}`)) : tests;
  return assign(units(scoped, weights), total)[shard - 1].keys.sort();
}

function listTests() {
  const result = spawnSync('pnpm', ['exec', 'playwright', 'test', '--list', '--reporter=json'], {cwd: root, encoding: 'utf8', maxBuffer: 1 << 28, shell: process.platform === 'win32', env: {...process.env, DUTY_E2E_URL: process.env.DUTY_E2E_URL ?? 'http://127.0.0.1:1'}});
  if (result.status !== 0) throw Error(`playwright --list failed: ${result.stderr}`);
  return collect(JSON.parse(result.stdout));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--update') {
    const weights = {};
    for (const test of collect(JSON.parse(readFileSync(process.argv[3], 'utf8')))) {
      const key = `${test.file}::${test.title}`;
      weights[key] = (weights[key] ?? 0) + Math.round(test.ms);
    }
    writeFileSync(weightsPath, JSON.stringify(Object.fromEntries(Object.entries(weights).sort()), null, 1) + '\n');
  } else {
    const shard = Number(process.argv[2]), total = Number(process.argv[3]);
    if (!Number.isInteger(shard) || !Number.isInteger(total) || shard < 1 || shard > total) throw Error('Usage: browser-shard.mjs <shard> <total>');
    const weights = JSON.parse(readFileSync(weightsPath, 'utf8'));
    const chosen = shardKeys(listTests(), weights, shard, total, process.argv.slice(4));
    if (chosen.length) console.log(chosen.map(key => `tests/browser/${key}`).join('\n')); // Empty output = nothing to run.
  }
}
