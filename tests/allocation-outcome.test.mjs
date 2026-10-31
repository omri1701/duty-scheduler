import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalDuties} from '../lib/scheduling/calendar.ts';
import {generatedNotes} from '../lib/allocation/outcome.ts';

const schedule = {month: '2026-11', calendar: {}, members: [], constraints: {}};
const input = (approvals = []) => ({schedule: {...schedule, approvals}, seniority: [], events: [], now: 0});
const duties = canonicalDuties('2026-11', {});

test('plan notes count back-to-back days per member; an approved fixed pair is not one', () => {
  const assignments = Object.fromEntries(duties.map(d => [d.id, {primary: null}]));
  assert.deepEqual(generatedNotes(input(), assignments), {generated: false, backToBack: {}});
  // Three days in a row count three; a lone duty and a day apart count nothing.
  for (const id of ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-05']) assignments[id] = {primary: 'a'};
  for (const id of ['2026-11-09', '2026-11-11']) assignments[id] = {primary: 'b'};
  // Thursday into the combined weekend touches; the weekend into Sunday does too.
  for (const id of ['2026-11-12', '2026-11-13', '2026-11-15']) assignments[id] = {primary: 'c'};
  assert.deepEqual(generatedNotes(input(), assignments), {generated: true, backToBack: {a: 3, c: 3}});
  const approved = [{rule: 'consecutive', duties: ['2026-11-01', '2026-11-02'], reason: 'Reviewed'}];
  assert.deepEqual(generatedNotes(input(approved), assignments).backToBack, {a: 2, c: 3});
});
