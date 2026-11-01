// Every error a user can meet says what happened in English and Hebrew (decision 2026-11-01):
// the codes the client libraries and the checked RPCs raise, and the RPCs' own sentences.
// A new code or sentence without a message fails here.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {userMessage} from '../lib/messages.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = (dir, ext) => readdirSync(join(root, dir)).flatMap(name => {
  const path = join(dir, name);
  return statSync(join(root, path)).isDirectory() ? files(path, ext) : ext.test(name) ? [path] : [];
});
const english = (en) => en, hebrew = (_en, he) => he;
const codes = new Set(), sentences = new Set();
for (const file of files('supabase/schemas', /\.sql$/)) {
  for (const [, text] of readFileSync(join(root, file), 'utf8').matchAll(/raise exception '((?:[^']|'')*)'/g)) {
    const message = text.replace(/''/g, '\'').replace(/%/g, 'X');
    (/^[a-z][a-z0-9-]*(:X)?$/.test(message) ? codes : sentences).add(message.replace(/:X$/, ':2027-01'));
  }
}
for (const dir of ['lib', 'hooks']) for (const file of files(dir, /\.ts$/)) {
  for (const [, code] of readFileSync(join(root, file), 'utf8').matchAll(/(?:fail|Error|CompensationError|GenerationError)\(['`]([a-z][a-z0-9-]+)(?::\$\{[^}]+\})?['`]/g)) codes.add(code);
  for (const [, text] of readFileSync(join(root, file), 'utf8').matchAll(/Error\('([A-Z][^']+)'\)/g)) sentences.add(text);
}

test('every error code has its own English and Hebrew message, never the code itself', () => {
  assert.ok(codes.size > 150, `scanned ${codes.size} codes`);
  for (const code of codes) {
    const en = userMessage(code, english), he = userMessage(code, hebrew);
    assert.ok(!en.includes(code.replace(/:.*/, '')) && en !== he && /[a-z]/.test(en) && /[֐-׿]/.test(he), `${code}: ${en} / ${he}`);
  }
});

test('every sentence the RPCs and clients raise has a Hebrew message too', () => {
  assert.ok(sentences.size > 60, `scanned ${sentences.size} sentences`);
  for (const sentence of sentences) {
    const en = userMessage(sentence, english), he = userMessage(sentence, hebrew);
    assert.ok(/[֐-׿]/.test(he) && en !== he, `${sentence}: ${en} / ${he}`);
  }
});

test('the plan\'s own notes pass through unchanged', () => {
  const note = 'December 2026 changed (balances: Avi −1), so the month was refreshed and your targets were kept. Check them, then confirm again.';
  assert.equal(userMessage(note, english), note);
  assert.equal(userMessage('review-replan-later:2027-01', english), 'January 2027 is already planned from this month’s points, so change January 2027 first.');
});
