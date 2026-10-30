// Real browser -> LOCAL Auth/PostgREST -> PostgreSQL. No mocked requests or captures.
// Run after pnpm build: pnpm exec node scripts/verify-duty-locks-local.mjs
import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {mkdir, writeFile} from 'node:fs/promises';
import {chromium, expect} from '@playwright/test';
import {createClient} from '@supabase/supabase-js';
import {prepareLocal, LOCAL_PASSWORD} from './local-supabase.mjs';
import {fromSnapshot, schedulePayload} from '../lib/supabase/snapshot.ts';
import {blocks, ownerMonth} from '../lib/rota/engine.ts';
import {initialCalendarMonth, monthNext, calendarMonthLabel} from '../lib/rota/calendar-dates.ts';

const env = await prepareLocal(), origin = 'http://127.0.0.1:5174';
assert.equal(env.SUPABASE_URL, 'http://127.0.0.1:48321');
const sql = query => execFileSync('docker', ['exec', '-i', 'supabase_db_duty-scheduler-app', 'psql', '-U', 'postgres', '-XqAt', '-v', 'ON_ERROR_STOP=1'], {input: query, encoding: 'utf8'}).trim();
assert.equal(sql("select exists(select 1 from supabase_migrations.schema_migrations where version='20261028204239');"), 't');
const client = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {auth: {persistSession: false, autoRefreshToken: false}});
const login = await client.auth.signInWithPassword({email: 'admin@duty.local', password: LOCAL_PASSWORD});
assert.ifError(login.error);
const load = async () => {const r = await client.rpc('duty_load'); assert.ifError(r.error); return r.data;};
const initial = await load(), admin = login.data.user.id;
assert(initial.members.filter(m => !m.is_temporary).every(m => m.email.endsWith('@duty.local')), 'Synthetic LOCAL workspace required');
const base = initialCalendarMonth();
const offset = Array.from({length: 24}, (_, i) => i).find(i => !initial.months.some(m => m.month === monthNext(base, i)));
assert.notEqual(offset, undefined, 'Need an unused future owner month');
const month = monthNext(base, offset), duty = blocks(month, []).find(d => ownerMonth(d) === month && !d.weekendId && d.start.slice(-2) >= '08');
const secondary = initial.members.find(m => m.id !== admin && m.active && m.status === 'approved').id;
let browser, server, created = false, trigger = false;
const proof = {target: env.SUPABASE_URL, month, day: duty.id, migrationInstalled: true};
try {
  const state = fromSnapshot(initial, admin);
  state.months[month] = {deadline: month + '-01', status: 'draft', generated: false};
  state.assignments[duty.id] = {primary: admin, secondary};
  const seeded = await client.rpc('duty_save_schedule', {p_state: schedulePayload(state, month), p_publish: null, p_revision: initial.revision});
  assert.ifError(seeded.error); created = true;
  server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '5174'], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, ...env, DUTY_SUPABASE_TARGET: 'local', DUTY_DEV_ORIGIN: '', DUTY_PRODUCTION_INSPECTION: ''},
  });
  let ready = false;
  for (let i = 0; i < 80; i++) {
    assert.equal(server.exitCode, null, 'Owned LOCAL preview exited');
    try {const r = await fetch(origin + '/api/config'); if (r.ok) {assert.equal((await r.json()).url, env.SUPABASE_URL); ready = true; break;}} catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert(ready, 'LOCAL preview must be ready on its separate port');
  browser = await chromium.launch();
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}, locale: 'en-GB', timezoneId: 'Asia/Jerusalem', reducedMotion: 'reduce'});
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin);
  await page.getByLabel('Password', {exact: true}).fill(LOCAL_PASSWORD);
  await page.getByRole('button', {name: 'Sign in locally', exact: true}).click();
  await expect(page.locator('.month-toolbar')).toBeVisible();
  for (let i = 0; i < offset; i++) await page.getByRole('button', {name: 'Next month', exact: true}).click();
  await expect(page.locator('.month-title h2')).toHaveText(calendarMonthLabel(month, 'en'));
  async function reloadMonth() {
    await page.reload(); await expect(page.locator('.month-toolbar')).toBeVisible();
    for (let i = 0; i < offset; i++) await page.getByRole('button', {name: 'Next month', exact: true}).click();
    await expect(page.locator('.month-title h2')).toHaveText(calendarMonthLabel(month, 'en'));
  }
  const cell = page.locator(`button[data-date="${duty.id}"]`).filter({has: page.locator('.date-line')});
  const dialog = page.getByRole('dialog'), indicator = cell.getByRole('img', {name: 'Locked duty'});
  const saved = async () => (await load()).assignments.find(d => d.publication_id === null && d.day === duty.id);
  const submit = async () => {await dialog.getByRole('button', {name: 'Save assignment', exact: true}).click(); await expect(dialog).toBeHidden();};
  async function cancelToggle(action) {
    const before = await saved();
    await cell.click(); await dialog.getByRole('button', {name: action, exact: true}).click(); await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden(); assert.deepEqual(await saved(), before);
  }
  await cancelToggle('Lock duty'); proof.cancelLock = true;
  await cell.click(); await dialog.getByRole('button', {name: 'Lock duty', exact: true}).click(); await submit();
  await expect(indicator).toBeVisible();
  assert.equal((await saved()).locked, true); proof.lockSaveAndIndicator = true;
  await reloadMonth(); await expect(indicator).toBeVisible(); proof.reload = true;
  await cancelToggle('Unlock duty'); proof.cancelUnlock = true;
  await page.getByRole('button', {name: /^(Generate month|Regenerate)$/}).click();
  const generate = dialog.getByRole('button', {name: 'Confirm & generate', exact: true});
  await expect(generate).toBeEnabled({timeout: 40_000});
  const generationResponse = page.waitForResponse(r => r.url() === env.SUPABASE_URL + '/rest/v1/rpc/duty_save_generation', {timeout: 60_000});
  await generate.click(); assert.equal((await generationResponse).status(), 200); await expect(dialog).toBeHidden({timeout: 60_000});
  assert.equal((await load()).months.find(m => m.month === month).generated, true);
  proof.checkedGenerationHttpStatus = 200;
  const generated = await saved();
  assert.equal(generated.primary_id, admin); assert.equal(generated.secondary_id, secondary); assert.equal(generated.locked, true);
  await reloadMonth(); await expect(indicator).toBeVisible(); proof.regeneratePreservesPrimaryAndEmergency = true;
  await cell.click(); await dialog.getByRole('button', {name: 'Unlock duty', exact: true}).click(); await submit();
  await reloadMonth(); await expect(cell).toBeVisible(); await expect(indicator).toHaveCount(0); assert.equal((await saved()).locked, false);
  const raw = await load(), facts = await client.rpc('duty_generation_context', {p_month: month, p_revision: raw.revision}); assert.ifError(facts.error);
  assert(!facts.data.facts.locks.some(l => l.dutyId === duty.id)); proof.unlockSaveAndReload = true;
  // A real HTTP-204 write that discards a lock must never produce success UI.
  sql(`create function duty_private.lock_browser_discard() returns trigger language plpgsql set search_path='' as $$begin if new.publication_id is null and new.day='${duty.id}' then new.locked:=false;end if;return new;end$$;
    create trigger lock_browser_discard before insert or update on public.duty_assignments for each row execute function duty_private.lock_browser_discard();`); trigger = true;
  await cell.click(); await dialog.getByRole('button', {name: 'Lock duty', exact: true}).click();
  const response = page.waitForResponse(r => r.url() === env.SUPABASE_URL + '/rest/v1/rpc/duty_save_schedule');
  await dialog.getByRole('button', {name: 'Save assignment', exact: true}).click(); assert.equal((await response).status(), 204);
  await expect(page.getByText('The duty lock was not saved as requested. Refresh and review the assignment before retrying.', {exact: true}).first()).toBeVisible();
  await expect(dialog).toBeVisible(); assert.equal((await saved()).locked, false); proof.ignoredWriteReportsFailure = true;
  sql('drop trigger lock_browser_discard on public.duty_assignments; drop function duty_private.lock_browser_discard();'); trigger = false;
  await submit(); await expect(indicator).toBeVisible(); assert.equal((await saved()).locked, true); proof.retryAfterFailure = true;
  assert.deepEqual(errors, []);
  console.log('PASS:', JSON.stringify(proof));
  await mkdir('work/duty-locks-local', {recursive: true}); await writeFile('work/duty-locks-local/result.json', JSON.stringify(proof, null, 2));
} finally {
  if (trigger) sql('drop trigger lock_browser_discard on public.duty_assignments; drop function duty_private.lock_browser_discard();');
  await browser?.close(); await client.auth.signOut({scope: 'local'});
  if (server?.pid) {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], {stdio: 'ignore', windowsHide: true}); else server.kill();
  }
  if (created) sql(`begin;select 1 from public.duty_workspace where id for update;
    delete from public.duty_allocations where month='${month}' and publication_id is null;
    delete from public.duty_assignments where publication_id is null and duty_private.duty_owner(day)='${month}';
    delete from public.duty_months where month='${month}' and current_publication_id is null;
    update public.duty_workspace set revision=revision+1 where id;commit;`);
}
