import {test, expect} from '@playwright/test';
import {monthFixture} from '../../lib/solver-spike/fixtures.ts';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';

test('production Worker loads self-hosted WASM, repeats deterministically, terminates and restarts', async ({page, request}) => {
  const wasm = await request.get('/api/solver-spike/asset/highs.wasm');
  expect(wasm.status()).toBe(200);
  expect(wasm.headers()['content-type']).toBe('application/wasm');
  expect(wasm.headers()['cache-control']).toBe('no-store');
  expect((await wasm.body()).subarray(0, 4).toString('hex')).toBe('0061736d');
  const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  expect(digest(await wasm.body())).toBe(digest(readFileSync(createRequire(import.meta.url).resolve('highs/runtime'))));
  expect(await (await request.get('/api/solver-spike/asset/LICENSE')).text()).toContain('MIT License');
  expect((await request.get('/api/solver-spike/asset/package.json')).status()).toBe(404);
  await page.goto('/solver-spike');
  await page.waitForFunction(() => !!window.solverSpike);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  const measured = await page.evaluate(async p => {
    const w = window.solverSpike!();
    try {
      const started = performance.now(), a = await w.run(p), coldMs = performance.now() - started;
      const warm = performance.now(), b = await w.run(p), warmMs = performance.now() - warm;
      const memories = [];
      for (let i = 0; i < 8; i++) memories.push((await w.run(p)).result.memoryBytes);
      return {a, b, coldMs, warmMs, memories};
    } finally {w.terminate();}
  }, monthFixture());
  expect(measured.a.result.assignment).toEqual(measured.b.result.assignment);
  expect(measured.a.result.allStagesProved).toBe(true);
  expect(measured.a.result.complete).toBe(true);
  expect(measured.a.result.activeModels).toBe(0);
  expect(new Set(measured.memories).size).toBe(1);
  await test.info().attach('highs-browser-measurements.json', {body: JSON.stringify(measured), contentType: 'application/json'});

  const cancel = await page.evaluate(async p => {
    const w = window.solverSpike!();
    let cancelMs = -1;
    const outcome = await w.run(p, {seed: 17, seconds: 20, nodes: 100000}, () => {
      // Let the synchronous solve begin; the main-thread timer must still fire.
      setTimeout(() => {
        const start = performance.now();
        w.terminate(); cancelMs = performance.now() - start;
      }, 100);
    }).then(() => 'unexpected result', e => e.message);
    const closed = await w.run(p).then(() => false, () => true);
    const fresh = window.solverSpike!();
    try {return {outcome, cancelMs, closed, restart: (await fresh.run({...p, spacing: false})).result.complete};}
    finally {fresh.terminate();}
  }, monthFixture('spacing'));
  expect(cancel.outcome).toBe('Worker terminated');
  expect(cancel.cancelMs).toBeLessThan(1000);
  expect(cancel.closed).toBe(true);
  expect(cancel.restart).toBe(true);
  expect(errors).toEqual([]);
});

test('browser constrained and spacing runs report verified results and proof limits', async ({page}) => {
  await page.goto('/solver-spike');
  await page.waitForFunction(() => !!window.solverSpike);
  const samples = [];
  for (const name of ['constrained', 'split', 'spacing'] as const) {
    const sample = await page.evaluate(async p => {
      const w = window.solverSpike!();
      try {return await w.run(p, {seed: 17, seconds: 5, nodes: 10000});}
      finally {w.terminate();}
    }, monthFixture(name));
    expect(sample.result.activeModels).toBe(0);
    expect(sample.result.stages.slice(0, -1).every(s => s.proved)).toBe(true);
    expect(sample.result.metrics.deficits.every(n => Number.isInteger(n) && n >= 0)).toBe(true);
    samples.push({name, ...sample});
  }
  await test.info().attach('highs-browser-constrained.json', {body: JSON.stringify(samples), contentType: 'application/json'});
});
