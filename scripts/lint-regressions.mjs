// Reject new lint errors while keeping pre-existing errors visible and reviewable.
// A baseline applies only to original source (normalizing CRLF); never refresh it to pass.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const baseline = JSON.parse(readFileSync(new URL('./lint-baseline.json', import.meta.url), 'utf8'));
const eslint = fileURLToPath(new URL('../node_modules/eslint/bin/eslint.js', import.meta.url));
const run = spawnSync(process.execPath, [eslint, '.', '--ignore-pattern', 'dist',
  '--ignore-pattern', '.next', '--format', 'json'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
if (run.error || ![0, 1].includes(run.status)) {
  console.error(run.error?.message || run.stderr || 'ESLint did not complete');
  process.exit(1);
}

const results = JSON.parse(run.stdout);
const signature = (message) => JSON.stringify([
  message.ruleId, message.line, message.column, message.endLine, message.endColumn,
]);
const expected = new Map(baseline.map(entry => [entry.file, entry]));
const seen = new Set();
let known = 0, unexpected = 0, warnings = 0;
for (const result of results) {
  const file = relative(root, result.filePath).replaceAll('\\', '/');
  const errors = result.messages.filter(message => message.severity === 2);
  warnings += result.warningCount;
  const entry = expected.get(file);
  const source = readFileSync(result.filePath, 'utf8').replace(/\r\n/g, '\n');
  const hash = createHash('sha256').update(source).digest('hex');
  const remaining = new Set(entry?.sha256 === hash ? entry.errors.map(signature) : []);
  for (const error of errors) {
    if (remaining.delete(signature(error))) {
      known++;
      console.warn(`Known lint debt: ${file}:${error.line}:${error.column} ${error.ruleId}`);
    } else {
      unexpected++;
      console.error(`${file}:${error.line}:${error.column} ${error.ruleId}\n${error.message}`);
    }
  }
  if (entry) {
    seen.add(file);
    if (remaining.size || (entry.sha256 !== hash && errors.length === 0)) {
      unexpected++;
      console.error(`Remove resolved baseline entries for ${file}; do not add allowances.`);
    }
  }
}
for (const file of expected.keys()) {
  if (!seen.has(file)) {
    unexpected++;
    console.error(`Baseline file was not linted: ${file}; investigate, then remove stale entries.`);
  }
}
console.log(`Lint: ${unexpected} unexpected issues; ${known} known errors; ${warnings} warnings.`);
process.exitCode = unexpected ? 1 : 0;
