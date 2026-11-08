import test from 'node:test';
import assert from 'node:assert/strict';
import {generationNow} from '../lib/allocation/client.ts';
import {coverageStart, requireGenerationWindow} from '../lib/scheduling/calendar.ts';
import {createGenerationRequest} from '../lib/scheduling/generate.ts';
import {monthScenario} from './fixtures/generation.mjs';

test('fractional monotonic samples produce integer server-based generation timestamps', () => {
  const {input, now: serverMs} = monthScenario('normal');
  const received = 100.25, current = 100.375;
  // The original hook passed this fractional epoch timestamp straight to the engine.
  assert.throws(() => createGenerationRequest(input, {now: serverMs + current - received}), /invalid-now/);
  for (const elapsed of [0, .125, .875, 1, 1.125, 1999.75, 60_000.5]) {
    const now = generationNow(serverMs, received, received + elapsed);
    assert.equal(now, serverMs + Math.floor(elapsed));
    assert.ok(Number.isSafeInteger(now));
    assert.doesNotThrow(() => createGenerationRequest(input, {now, seed: 17}));
  }
});

test('fractional elapsed time preserves the exact owner-month cutoff, including Saturday ownership', () => {
  for (const [month, instant] of [['2026-11', '2026-11-01T07:00:00Z'], ['2028-01', '2028-01-02T07:00:00Z']]) {
    const opening = coverageStart(month, {});
    assert.equal(opening, Date.parse(instant));
    const received = .01, serverMs = opening - 1;
    for (const current of [.01, .135, 1.00999]) {
      const now = generationNow(serverMs, received, current);
      assert.equal(now, opening - 1, 'sub-millisecond elapsed time must not round up at epoch magnitude');
      assert.doesNotThrow(() => requireGenerationWindow(month, {}, now));
    }
    for (const [current, expected] of [[1.01, opening], [1.135, opening], [2.135, opening + 1]]) {
      const now = generationNow(serverMs, received, current);
      assert.equal(now, expected);
      assert.throws(() => requireGenerationWindow(month, {}, now), /generation-window-closed/);
    }
  }
});

test('a refreshed server sample uses its own monotonic origin', () => {
  const serverMs = coverageStart('2026-11', {}) - 60_000;
  assert.equal(generationNow(serverMs, 100.25, 5100.875), serverMs + 5000);
  assert.equal(generationNow(serverMs + 6000, 5100.875, 5101), serverMs + 6000);
});

test('the engine still rejects fractional, non-finite and unsafe generation timestamps', () => {
  const opening = coverageStart('2026-11', {});
  for (const now of [opening - .5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => requireGenerationWindow('2026-11', {}, now), /invalid-now/);
  }
});
