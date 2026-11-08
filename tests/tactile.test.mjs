import test from 'node:test';
import assert from 'node:assert/strict';
import {tactileTick} from '../lib/tactile.ts';

test('feedback detects support, drops rapid events without a queue, and respects user settings', t => {
  const originals = Object.fromEntries(['window', 'document', 'navigator'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let now = 1000, reduced = false, hidden = false, permitted = true;
  const calls = [];
  t.mock.method(performance, 'now', () => now);
  Object.defineProperties(globalThis, {
    window: {configurable: true, value: {matchMedia: () => ({matches: reduced})}},
    document: {configurable: true, value: {get visibilityState() {return hidden ? 'hidden' : 'visible';}}},
    navigator: {configurable: true, value: {userActivation: {get hasBeenActive() {return permitted;}}, vibrate: duration => {calls.push(duration); return true;}}},
  });
  t.after(() => {for (const [key, descriptor] of Object.entries(originals)) {if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];}});
  assert.equal(tactileTick(), true);
  for (let i = 0; i < 60; i++) {now++; assert.equal(tactileTick(), false);}
  now += 80;
  assert.equal(tactileTick(), true);
  assert.deepEqual(calls, [8, 8]);
  reduced = true; now += 100; assert.equal(tactileTick(), false);
  reduced = false; hidden = true; assert.equal(tactileTick(), false);
  hidden = false; permitted = false; assert.equal(tactileTick(), false);
  permitted = true; now += 100; delete navigator.vibrate;
  assert.equal(tactileTick(), false);
  assert.deepEqual(calls, [8, 8]);
});
