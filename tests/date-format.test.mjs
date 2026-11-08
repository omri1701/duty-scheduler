import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dateRange} from '../lib/date-format.ts';

test('availability date titles: single, chronological ranges, months and years', () => {
  assert.equal(dateRange(['2026-10-12'], 'en'), '12 October');
  assert.equal(dateRange(['2026-10-17', '2026-10-12'], 'en'), '12–17 October');
  assert.equal(dateRange(['2026-11-02', '2026-10-30'], 'en'), '30 October–2 November');
  assert.equal(dateRange(['2027-01-02', '2026-12-30'], 'en'), '30 December 2026–2 January 2027');
  assert.equal(dateRange(['2026-10-12'], 'he'), '12 באוקטובר');
  assert.equal(dateRange(['2026-10-17', '2026-10-12'], 'he'), '12–17 באוקטובר');
  assert.equal(dateRange(['2026-11-02', '2026-10-30'], 'he'), '30 באוקטובר–2 בנובמבר');
  assert.equal(dateRange([], 'en'), '');
});
