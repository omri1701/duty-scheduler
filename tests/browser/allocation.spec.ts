import {test, expect, ids, MONTH, type Backend} from './fixtures';
import {coverageStart} from '../../lib/scheduling/calendar';
import {validateGeneration} from '../../lib/scheduling/validate';

function fresh(backend: Backend, count = 6) {
  backend.raw.assignments = []; backend.raw.publications = [];
  backend.raw.months[0] = {...backend.raw.months[0], current_publication_id: null, status: 'draft', generated: false};
  backend.raw.members.forEach((m, i) => {if (i >= count && m.status === 'approved') m.active = false;});
}
function acceptedDraft(backend: Backend) {
  backend.raw.assignments.push({id: 'accepted', publication_id: null, day: '2026-11-02', end_day: '2026-11-03', primary_id: ids.admin, secondary_id: ids.a, title: '', extra_points: 0, points: 1, manager_override: false});
}
async function openPlan(page: import('@playwright/test').Page) {
  await page.getByRole('button', {name: /^(Generate month|Regenerate)$/}).click();
  await expect(page.getByRole('dialog', {name: 'Plan the month'})).toBeVisible();
  await expect(page.getByRole('button', {name: /^(Confirm & generate|Generate partial)$/})).toBeEnabled({timeout: 30_000});
}

test('allocation controls preserve one-point and half-point intent, redistribute, undo and restore keyboard focus', async ({page, backend, openApp}) => {
  fresh(backend); await openApp(); await openPlan(page);
  const first = page.locator('.allocation-row').first(), values = first.locator('output');
  const original = Number(await values.first().textContent());
  await first.getByRole('button', {name: 'Decrease Target · Avery Admin', exact: true}).click();
  await expect(values.first()).toHaveText(String(original - 1));
  await expect(page.getByRole('button', {name: '0.5', exact: true})).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('button', {name: /^(Confirm & generate|Generate partial)$/})).toBeEnabled();
  await page.getByRole('button', {name: 'Undo', exact: true}).click();
  await expect(values.first()).toHaveText(String(original));
  await page.getByRole('button', {name: '0.5', exact: true}).click();
  await first.getByRole('button', {name: 'Increase Permanent · Avery Admin', exact: true}).click();
  await expect(values.last()).toHaveText('+0.5');
  await expect(values.first()).toHaveText(String(original + .5));
  await expect(page.getByRole('button', {name: 'Confirm & generate', exact: true})).toBeDisabled();
  await page.locator('.allocation-row').nth(1).getByRole('button', {name: 'Decrease Permanent · Alex Atlas', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Confirm & generate', exact: true})).toBeEnabled();
  // Whole-point duties cannot achieve these half targets; UNKNOWN does not block.
  await expect(page.getByRole('dialog')).toContainText('Permanent');
  expect(backend.calls.filter(c => c.name === 'duty_confirm_allocation')).toHaveLength(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByRole('button', {name: 'Generate month', exact: true})).toBeFocused();
  await openPlan(page);
  await expect(page.getByRole('button', {name: '1', exact: true})).toHaveAttribute('aria-pressed', 'true');
});

for (const [width, lang] of [[320, 'he'], [375, 'en'], [1440, 'en']] as const) {
  test(`allocation visual review at ${width}px in ${lang}`, async ({page, backend, openApp}, info) => {
    fresh(backend); await page.setViewportSize({width, height: width === 1440 ? 1000 : 812}); await openApp();
    if (lang === 'he') await page.getByRole('button', {name: 'Switch to Hebrew'}).click();
    await page.getByRole('button', {name: lang === 'he' ? 'יצירת שיבוץ' : 'Generate month', exact: true}).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', {name: lang === 'he' ? 'אישור ושיבוץ' : 'Confirm & generate', exact: true})).toBeEnabled({timeout: 30_000});
    await expect(dialog).toHaveAttribute('dir', lang === 'he' ? 'rtl' : 'ltr');
    const sizes = await dialog.evaluate(el => ({width: el.clientWidth, scroll: el.scrollWidth, rows: [...el.querySelectorAll('.allocation-row')].map(row => ({width: row.clientWidth, scroll: row.scrollWidth})),
      footer: el.querySelector('.allocation-footer')!.getBoundingClientRect().toJSON(), bounds: el.getBoundingClientRect().toJSON()}));
    expect(sizes.scroll).toBeLessThanOrEqual(sizes.width);
    expect(sizes.rows.every(r => r.scroll <= r.width)).toBe(true);
    expect(sizes.footer.bottom).toBeLessThanOrEqual(812 + (width === 1440 ? 188 : 0));
    await info.attach(`allocation-${lang}-${width}.png`, {body: await page.screenshot(), contentType: 'image/png'});
    await info.attach('layout.json', {body: JSON.stringify(sizes), contentType: 'application/json'});
    await page.locator('.allocation-scroll').evaluate(el => {el.scrollTop = el.scrollHeight;});
    await expect(dialog.locator('.allocation-footer')).toBeInViewport();
    await page.keyboard.press('Tab'); await expect(dialog.locator(':focus')).toHaveCount(1);
  });
}

test('real generation Worker saves a verified partial, retains targets and emergency cover, and blocks publication', async ({page, backend, openApp}) => {
  fresh(backend, 2);
  backend.raw.assignments.push({id: 'emergency', publication_id: null, day: '2026-11-02', end_day: '2026-11-03', primary_id: null, secondary_id: ids.a, title: '', extra_points: 0, points: 1, manager_override: false});
  await openApp(); await openPlan(page);
  const targets = await page.locator('.allocation-row output').allTextContents();
  await page.getByRole('button', {name: 'Generate partial', exact: true}).click();
  await expect(page.getByRole('dialog')).toBeHidden({timeout: 50_000});
  await expect(page.getByText('Partial · Requires Manager Resolution', {exact: true})).toBeVisible();
  await expect(page.locator('.allocation-uncovered')).toContainText('Uncovered dates');
  await expect(page.getByRole('button', {name: 'Publish', exact: true})).toBeDisabled();
  expect(backend.raw.assignments.find(d => d.day === '2026-11-02')!.secondary_id).toBe(ids.a);
  const confirm = backend.calls.find(c => c.name === 'duty_confirm_allocation')!, save = backend.calls.find(c => c.name === 'duty_save_generation')!;
  expect(save.params.p_revision).toBe(Number(confirm.params.p_revision) + 1);
  const context = backend.generationEnvelope(MONTH), allocation = backend.allocations.get(MONTH)!.draft;
  const metrics = validateGeneration({month: MONTH, sourceRevision: String(context.revision), calendar: {}, members: context.facts.members, constraints: context.facts.constraints,
    targets: Object.fromEntries(Object.entries(allocation.targetsUnits).map(([id, u]) => [id, u / 2])), secondary: {'2026-11-02': ids.a}}, save.params.p_assignments as Parameters<typeof validateGeneration>[1]);
  expect(metrics.deficits.some(n => n > 0)).toBe(true);
  await page.getByRole('button', {name: 'Review allocation', exact: true}).click();
  await expect(page.locator('.allocation-row output')).toHaveText(targets);
});

test('fractional monotonic time generates and saves through a real Worker', async ({page, backend, openApp}) => {
  fresh(backend); await openApp(); await openPlan(page);
  // Fixed browser dates can hide the fractional performance.now() values seen in production.
  await page.evaluate(() => {
    let ms = 100.25;
    Object.defineProperty(performance, 'now', {configurable: true, value: () => {ms += .125; return ms;}});
  });
  let workers = 0; page.on('worker', () => {workers++;});
  await page.getByRole('button', {name: 'Confirm & generate', exact: true}).click();
  await expect(page.getByRole('dialog')).toBeHidden({timeout: 50_000});
  expect(workers).toBeGreaterThanOrEqual(2); // Generation and allocation compilation both ran in Workers.
  await expect(page.getByText('All duties covered', {exact: true})).toBeVisible();
  expect(backend.calls.filter(c => c.name === 'duty_save_generation')).toHaveLength(1);
  expect(backend.raw.months[0].generated).toBe(true);
});

test('cancelling synchronous WASM retains accepted assignments and a fresh Worker can retry', async ({page, backend, openApp}) => {
  fresh(backend); acceptedDraft(backend); await openApp(); await openPlan(page);
  const before = structuredClone(backend.raw.assignments);
  let release!: () => void; const gate = new Promise<void>(resolve => {release = resolve;});
  await page.route('**/api/scheduling/asset/highs.mjs', async route => {await gate; await route.continue();});
  const started = page.waitForEvent('worker');
  await page.getByRole('button', {name: 'Confirm & generate', exact: true}).click();
  const active = await started, stopped = active.waitForEvent('close');
  await expect(page.getByText('Finding the best arrangement…', {exact: true})).toBeVisible();
  await page.getByRole('button', {name: 'Cancel', exact: true}).click(); release();
  await stopped;
  expect(backend.raw.assignments).toEqual(before);
  expect(backend.calls.filter(c => c.name === 'duty_save_generation')).toHaveLength(0);
  await expect(page.getByText('Cancelled. Your saved draft is unchanged.', {exact: true})).toBeVisible();
  await page.unroute('**/api/scheduling/asset/highs.mjs');
  const restarted = page.waitForEvent('worker');
  await page.getByRole('button', {name: 'Confirm & generate', exact: true}).click();
  expect(await restarted).not.toBe(active);
  await expect(page.getByRole('dialog')).toBeHidden({timeout: 50_000});
  expect(backend.calls.filter(c => c.name === 'duty_save_generation')).toHaveLength(1);
});

test('stale checked save preserves the draft, requires explicit review and never retries the stale write', async ({page, backend, openApp}) => {
  fresh(backend); acceptedDraft(backend); await openApp(); await openPlan(page);
  const targets = await page.locator('.allocation-row output').allTextContents(), before = structuredClone(backend.raw.assignments);
  backend.failGenerationSave = true;
  await page.getByRole('button', {name: 'Confirm & generate', exact: true}).click();
  await expect(page.getByRole('alert')).toContainText('Team data changed', {timeout: 50_000});
  expect(backend.raw.assignments).toEqual(before);
  expect(backend.calls.filter(c => c.name === 'duty_save_generation')).toHaveLength(1);
  await expect(page.getByRole('button', {name: 'Confirm & generate', exact: true})).toBeDisabled();
  await page.getByRole('button', {name: 'Refresh & review retained targets', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Confirm & generate', exact: true})).toBeEnabled({timeout: 20_000});
  await expect(page.locator('.allocation-row output')).toHaveText(targets);
  await page.getByRole('button', {name: 'Confirm & generate', exact: true}).click();
  await expect(page.getByRole('dialog')).toBeHidden({timeout: 50_000});
  expect(backend.calls.filter(c => c.name === 'duty_save_generation')).toHaveLength(2);
});

test('a real Worker asset failure retains the accepted draft and recovers after explicit review', async ({page, backend, openApp}) => {
  fresh(backend); acceptedDraft(backend); await openApp(); await openPlan(page);
  const before = structuredClone(backend.raw.assignments);
  await page.route('**/api/scheduling/asset/highs.mjs', route => route.abort('failed'));
  await page.getByRole('button', {name: 'Confirm & generate', exact: true}).click();
  await expect(page.getByRole('alert')).toContainText('planner could not start', {timeout: 15_000});
  expect(backend.raw.assignments).toEqual(before);
  expect(backend.calls.filter(c => c.name === 'duty_save_generation')).toHaveLength(0);
  await page.unroute('**/api/scheduling/asset/highs.mjs');
  await page.getByRole('button', {name: 'Refresh & review retained targets', exact: true}).click();
  await page.getByRole('button', {name: 'Confirm & generate', exact: true}).click();
  await expect(page.getByRole('dialog')).toBeHidden({timeout: 50_000});
  expect(backend.calls.filter(c => c.name === 'duty_save_generation')).toHaveLength(1);
});

test('lock approval is exact, reasoned and saved separately from primary generation', async ({page, backend, openApp}) => {
  fresh(backend);
  backend.raw.assignments.push({id: 'manual', publication_id: null, day: '2026-11-04', end_day: '2026-11-05', primary_id: ids.a, secondary_id: null, title: '', extra_points: 0, points: 1, manager_override: true});
  await openApp(); await openPlan(page);
  await page.getByText('Explicit locks & exceptions', {exact: false}).click();
  await page.locator('.allocation-lock-list input').check();
  await expect(page.getByRole('alert')).toContainText('unavailable');
  await page.getByLabel('Reason for new exceptions', {exact: true}).fill('Reviewed this specific coverage with Alex');
  await page.locator('.allocation-exception input').check();
  await page.getByRole('button', {name: 'Confirm & generate', exact: true}).click();
  await expect(page.getByRole('dialog')).toBeHidden({timeout: 50_000});
  const confirm = backend.calls.find(c => c.name === 'duty_confirm_allocation')!;
  expect(confirm.params.p_locks).toEqual([{dutyId: '2026-11-04', engineer: ids.a}]);
  expect(confirm.params.p_approvals).toEqual([{rule: 'availability', dutyId: '2026-11-04', engineer: ids.a, dates: ['2026-11-04'], reason: 'Reviewed this specific coverage with Alex'}]);
  expect(backend.raw.assignments.find(d => d.day === '2026-11-04')!.primary_id).toBe(ids.a);
  expect(backend.raw.constraints[0].note).toBe('Synthetic vacation');
  const metadata = backend.allocations.get(MONTH)!;
  metadata.approvals = metadata.approvals.map(a => Object.fromEntries(Object.entries(a).reverse()) as typeof a);
  await page.reload(); await openPlan(page);
  await page.getByText('Explicit locks & exceptions', {exact: false}).click();
  await expect(page.locator('.allocation-exception input')).toBeChecked();
});

test('unsupported browser explains recovery without running the old generator', async ({page, backend, openApp}) => {
  fresh(backend); await page.addInitScript(() => {Object.defineProperty(window, 'WebAssembly', {value: undefined});});
  await openApp(); await page.getByRole('button', {name: 'Generate month', exact: true}).click();
  await expect(page.getByRole('alert')).toContainText('This browser cannot run the planner');
  expect(backend.calls.filter(c => c.name === 'duty_confirm_allocation' || c.name === 'duty_save_generation')).toHaveLength(0);
});

test('cutoff disables generation even on an empty draft and keeps manual editing available', async ({page, backend, openApp}) => {
  fresh(backend); backend.generationNow = coverageStart(MONTH, {});
  await openApp();
  await expect.poll(() => backend.calls.filter(c => c.name === 'duty_generation_context').length).toBeGreaterThan(0);
  await expect(page.getByRole('button', {name: 'Generate month', exact: true})).toBeDisabled();
  await expect(page.getByText('Coverage has started. Use manual assignments or swaps; generation is closed.', {exact: true})).toBeVisible();
  await page.locator('button[data-date="2026-11-02"]').filter({has: page.locator('.date-line')}).click();
  await expect(page.getByRole('dialog', {name: 'Edit duty'})).toBeVisible();
});

test('a cutoff crossed with the popup open cancels planning and never changes assignments', async ({page, backend, openApp}) => {
  fresh(backend); backend.generationNow = coverageStart(MONTH, {}) - 1500;
  const before = structuredClone(backend.raw.assignments);
  await openApp(); await page.getByRole('button', {name: 'Generate month', exact: true}).click();
  await expect(page.getByRole('dialog')).toContainText('Monthly coverage has started', {timeout: 10_000});
  expect(backend.raw.assignments).toEqual(before);
  expect(backend.calls.filter(c => c.name === 'duty_save_generation')).toHaveLength(0);
});

test('exact cutoff during real Worker generation terminates it without saving assignments', async ({page, backend, openApp}) => {
  fresh(backend); acceptedDraft(backend); backend.generationNow = coverageStart(MONTH, {}) - 60_000;
  const before = structuredClone(backend.raw.assignments);
  await openApp(); await openPlan(page);
  await page.evaluate(() => {Object.defineProperty(performance, 'now', {configurable: true, value: () => 100.25});});
  let release!: () => void; const gate = new Promise<void>(resolve => {release = resolve;});
  await page.route('**/api/scheduling/asset/highs.mjs', async route => {await gate; await route.continue();});
  const started = page.waitForEvent('worker');
  await page.getByRole('button', {name: 'Confirm & generate', exact: true}).click();
  const active = await started, stopped = active.waitForEvent('close');
  await expect(page.getByText('Finding the best arrangement…', {exact: true})).toBeVisible();
  // The confirmed server sample was received at 100.25; advance exactly 60 seconds.
  await page.evaluate(() => {Object.defineProperty(performance, 'now', {configurable: true, value: () => 60_100.25});});
  await stopped; release();
  await expect(page.getByRole('dialog')).toContainText('Monthly coverage has started');
  expect(backend.raw.assignments).toEqual(before);
  expect(backend.calls.filter(c => c.name === 'duty_save_generation')).toHaveLength(0);
});

test('cutoff equality at the checked save rejects a late result atomically', async ({page, backend, openApp}) => {
  fresh(backend); await openApp(); await openPlan(page);
  const before = structuredClone(backend.raw.assignments);
  await page.route('**/rest/v1/rpc/duty_save_generation', async route => {
    backend.generationNow = coverageStart(MONTH, {}); await route.fallback();
  });
  await page.getByRole('button', {name: 'Confirm & generate', exact: true}).click();
  await expect(page.getByRole('alert')).toContainText('Coverage has started', {timeout: 45_000});
  expect(backend.raw.assignments).toEqual(before);
  expect(backend.calls.filter(c => c.name === 'duty_save_generation')).toHaveLength(1);
});

test('missing owner month opens only on confirmation, then uses the returned captured revision', async ({page, backend, openApp}) => {
  fresh(backend); backend.raw.months = [];
  await openApp(); await openPlan(page);
  expect(backend.calls.filter(c => c.name === 'duty_save_schedule')).toHaveLength(0);
  await page.getByRole('button', {name: 'Confirm & generate', exact: true}).click();
  await expect(page.getByRole('dialog')).toBeHidden({timeout: 50_000});
  const open = backend.calls.find(c => c.name === 'duty_save_schedule')!;
  const confirm = backend.calls.find(c => c.name === 'duty_confirm_allocation')!;
  expect(confirm.params.p_revision).toBe(Number(open.params.p_revision) + 1);
  expect(backend.raw.months.find(m => m.month === MONTH)?.generated).toBe(true);
});

test('WASM assets are pinned same-origin executable files with an exact allowlist', async ({request}) => {
  const wasm = await request.get('/api/scheduling/asset/highs.wasm');
  expect(wasm.status()).toBe(200); expect(wasm.headers()['content-type']).toBe('application/wasm');
  expect(wasm.headers()['x-content-type-options']).toBe('nosniff');
  expect(wasm.headers()['cross-origin-resource-policy']).toBe('same-origin');
  expect((await wasm.body()).subarray(0, 4).toString('hex')).toBe('0061736d');
  expect((await request.get('/api/scheduling/asset/package.json')).status()).toBe(404);
  expect(await (await request.get('/api/scheduling/asset/LICENSE')).text()).toContain('MIT License');
});

for (const count of [12, 24]) {
  test(`real planner and generation performance with ${count} engineers`, async ({page, backend, openApp}, info) => {
    fresh(backend);
    while (backend.raw.members.filter(m => m.status === 'approved').length < count) {
      const n = backend.raw.members.length;
      backend.raw.members.push({...backend.raw.members[1], id: `21000000-0000-4000-8000-${String(n).padStart(12, '0')}`, name: `Engineer ${n}`, email: `engineer-${n}@example.invalid`, seniority: n});
    }
    await openApp();
    const start = performance.now(); await openPlan(page); const proposalMs = performance.now() - start;
    const solve = performance.now(); await page.getByRole('button', {name: 'Confirm & generate', exact: true}).click();
    await expect(page.getByRole('dialog')).toBeHidden({timeout: 50_000});
    const generationMs = performance.now() - solve;
    await expect(page.getByText('All duties covered', {exact: true})).toBeVisible();
    await info.attach('allocation-timing.json', {body: JSON.stringify({count, project: info.project.name, proposalMs, generationMs, includes: 'Worker initialization, domain work, intercepted checked RPCs and UI feedback'}), contentType: 'application/json'});
  });
}
