import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';

// MiKo rename (2026-11-07): the Hebrew UI says כוננות / כוננויות for a duty and כונן/ית for the
// person on duty, never the older word family (taf-vav-resh-nun). Escaped so this file never matches itself.
const OLD = /\u05EA\u05D5\u05E8\u05E0|\u05EA\u05D5\u05E8\u05DF/;
const ROOTS = ['app', 'components', 'hooks', 'lib', 'public', 'scripts', 'supabase', 'tests', 'docs', 'README.md'];
const SKIP = new Set(['node_modules', 'snapshots', '.next', 'archive']);
const TEXT = /\.(ts|tsx|mjs|js|css|md|json|sql|html)$/;

function files(path) {
  if (SKIP.has(path.split(/[\/]/).at(-1))) return [];
  return statSync(path).isDirectory() ? readdirSync(path).flatMap(name => files(join(path, name))) : TEXT.test(path) ? [path] : [];
}

test('no Hebrew string uses the old word for duty', () => {
  const hits = ROOTS.flatMap(files).flatMap(file => readFileSync(file, 'utf8').split('\n')
    .map((line, i) => OLD.test(line) ? `${file}:${i + 1}: ${line.trim().slice(0, 120)}` : null).filter(Boolean));
  assert.deepEqual(hits, []);
});
