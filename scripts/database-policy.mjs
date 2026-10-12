import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

export function validateDatabaseChange(changes, previousNames) {
  const migrations = changes.filter(({file}) => /^supabase\/migrations\/.*\.sql$/.test(file));
  const sources = changes.filter(({file}) => /^supabase\/(schemas|reference-data)\/.*\.sql$/.test(file));
  const latest = previousNames.map(name => name.split('/').at(-1).slice(0, 14)).sort().at(-1);
  for (const {status, file} of migrations) {
    assert.equal(status, 'A', `Applied migration cannot be changed or deleted: ${file}`);
    assert.match(file, /^supabase\/migrations\/\d{14}_[a-z0-9_]+\.sql$/);
    assert(file.split('/').at(-1).slice(0, 14) > latest, 'New migrations must follow all existing versions');
  }
  if (sources.length || migrations.length) {
    assert(sources.length && migrations.length, 'Canonical SQL and new incremental migrations belong in the same PR');
    assert(changes.some(({file}) => /^supabase\/tests\//.test(file)), 'Database changes require relevant SQL/security/upgrade regressions');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const base = process.argv[2];
  assert.match(base ?? '', /^[a-f0-9]{40}$/, 'Pass the immutable PR base or previous push SHA');
  const git = args => {
    const result = spawnSync('git', args, {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const changes = git(['diff', '--name-status', '--no-renames', base, 'HEAD']).split('\n').filter(Boolean)
    .map(line => { const [status, file] = line.split('\t'); return {status, file}; });
  validateDatabaseChange(changes, git(['ls-tree', '--name-only', base, 'supabase/migrations/']).split('\n'));
  console.log('PASS: immutable migration history and paired canonical SQL/regressions');
}
