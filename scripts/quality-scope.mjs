// Fail closed: only known prose and validated AI instructions can skip app/DB checks.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {appendFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

export function instructionOnly(event, files) {
  return event === 'pull_request' && files.length > 0 && files.every(file =>
    ['README.md', 'AGENTS.md', '.codex/config.toml', '.codex/agents/qa.toml', '.codex/agents/security.toml'].includes(file)
    || /^docs\/[\w/-]+\.md$/.test(file)
    || /^\.agents\/skills\/(scheduling-regression|code-change-validation|security-review|feature-delivery)\/SKILL\.md$/.test(file));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const {GITHUB_EVENT_NAME: event, PR_BASE: base, GITHUB_OUTPUT: output} = process.env;
  let files = [];
  if (event === 'pull_request') {
    assert.match(base ?? '', /^[a-f0-9]{40}$/);
    const diff = spawnSync('git', ['diff', '--name-only', '-z', '--no-renames', base, 'HEAD'], {encoding: 'utf8'});
    assert.equal(diff.status, 0, diff.stderr);
    files = diff.stdout.split('\0').filter(Boolean);
  }
  await appendFile(output, `full=${!instructionOnly(event, files)}\n`);
}
