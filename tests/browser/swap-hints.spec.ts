// Swap-target hints (decision 2026-11-05): while a swap is chosen, a day the server would refuse
// is greyed with a short reason (who and which day, never the note); the usable days stay green.
import type {Page} from '@playwright/test';
import {test, expect, ids, duty, dragTo, targetReady, NOW, switchLanguage, openDutySheet} from './fixtures';

type Lang = 'en' | 'he';
const say = (lang: Lang) => (en: string, he: string) => lang === 'en' ? en : he;
async function language(page: Page, lang: Lang) {
  await expect(page.locator('[data-settings-button]')).toBeVisible();
  if (lang === 'he') await switchLanguage(page, 'he');
}
// The duty sheet's Swap sets the source (decision 2026-11-06).
async function startSwap(page: Page, day: string) {
  await (await openDutySheet(page, day)).getByRole('button', {name: /^(Swap|החלפה)$/}).click();
  await expect(duty(page, day)).toHaveAttribute('aria-pressed', 'true');
}
async function expectBlocked(page: Page, day: string, reason: string) {
  const cell = duty(page, day);
  await expect(cell).toHaveClass(/swap-blocked/);
  await expect(cell).toHaveAttribute('aria-disabled', 'true');
  await expect(cell).toHaveAttribute('title', reason);
  await expect(cell).toHaveAccessibleName(new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'));
  await expect(cell).not.toHaveClass(/drag-target/);
}
async function expectGreen(page: Page, day: string) {
  await expect(duty(page, day)).toHaveClass(/drag-target/);
  await expect(duty(page, day)).not.toHaveClass(/swap-blocked/);
}
// A tap (or Enter) on a greyed day says why and opens nothing.
async function expectTapHint(page: Page, day: string, reason: string) {
  // aria-disabled keeps the day focusable and tappable, so it can say why.
  await duty(page, day).click({force: true});
  await expect(page.locator('[data-sonner-toast]').filter({hasText: reason})).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
async function hold(page: Page, from: string, to: string, touch: boolean) {
  const a = (await duty(page, from).boundingBox())!, b = (await duty(page, to).boundingBox())!;
  await dragTo(page, a.x + a.width / 2, a.y + a.height / 2, b.x + b.width / 2, b.y + b.height / 2, touch, to);
}

for (const lang of ['en', 'he'] as const) {
  test(`engineer: "you can't" and "they can't" days are greyed with a reason ${lang}`, async ({page, openApp, backend}) => {
    const t = say(lang);
    // Alex is unavailable on 5 Nov (Drew's day); Blair on 2 Nov (Alex's own day).
    backend.raw.constraints.push({member_id: ids.a, day: '2026-11-05', kind: 'no', note: 'Alex private note'},
      {member_id: ids.b, day: '2026-11-02', kind: 'no', note: 'Blair private note'});
    await openApp('a'); await language(page, lang);
    await startSwap(page, '2026-11-02');
    await targetReady(page, '2026-11-05');
    await expectBlocked(page, '2026-11-05', t('You can’t take 5 Nov', 'אין לך אפשרות לקחת את 5 בנוב׳'));
    await expectBlocked(page, '2026-11-03', t('Blair Birch can’t take your day', 'לBlair Birch אין אפשרות לקחת את התורנות שלך'));
    await expectGreen(page, '2026-11-12');
    await expect(page.locator('#published-swap-help')).toHaveText(t('Choose the duty to swap with. Greyed days say why. Escape cancels.', 'בחרו את התורנות להחלפה. ימים אפורים מסבירים למה. Escape לביטול.'));
    // Keyboard: Space on a greyed day explains; a green day opens the request.
    await duty(page, '2026-11-05').focus(); await page.keyboard.press('Space');
    await expect(page.locator('[data-sonner-toast]').filter({hasText: t('You can’t take 5 Nov', 'אין לך אפשרות לקחת את 5 בנוב׳')})).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expectTapHint(page, '2026-11-03', t('Blair Birch can’t take your day', 'לBlair Birch אין אפשרות לקחת את התורנות שלך'));
    // Private notes are never shown.
    for (const note of ['Synthetic vacation', 'Alex private note', 'Blair private note']) await expect(page.locator('body')).not.toContainText(note);
    await duty(page, '2026-11-12').click();
    await expect(page.getByRole('dialog', {name: t('Ask to swap', 'בקשת החלפה')})).toBeVisible();
    await expect(page.getByRole('button', {name: t('Confirm Request', 'אישור בקשה'), exact: true})).toBeEnabled();
    expect(backend.calls.filter(c => c.name === 'duty_request_swap')).toHaveLength(0);
  });

  test(`admin swapping two others reads names, by the editor button or by dragging ${lang}`, async ({page, openApp, backend}, info) => {
    const t = say(lang);
    backend.raw.months[0].status = 'published';
    // Blair can't take 5 Nov (Drew's); Casey can't take Blair's 3 Nov.
    backend.raw.constraints.push({member_id: ids.b, day: '2026-11-05', kind: 'no', note: 'Admin-only note'},
      {member_id: ids.c, day: '2026-11-03', kind: 'no', note: 'Another note'});
    await openApp('admin'); await language(page, lang);
    await (await openDutySheet(page, '2026-11-03')).getByRole('button', {name: t('Edit', 'עריכה'), exact: true}).click();
    await page.getByRole('dialog', {name: t('Edit duty', 'עריכת תורנות')}).getByRole('button', {name: t('Swap with another duty…', 'החלפה עם תורנות אחרת…'), exact: true}).click();
    await expect(duty(page, '2026-11-03')).toHaveAttribute('aria-pressed', 'true');
    await expectBlocked(page, '2026-11-05', t('Blair Birch can’t take 5 Nov', 'לBlair Birch אין אפשרות לקחת את 5 בנוב׳'));
    await expectBlocked(page, '2026-11-04', t('Casey Cedar can’t take Blair Birch’s day', 'לCasey Cedar אין אפשרות לקחת את התורנות של Blair Birch'));
    await expectGreen(page, '2026-11-09');
    await expectTapHint(page, '2026-11-05', t('Blair Birch can’t take 5 Nov', 'לBlair Birch אין אפשרות לקחת את 5 בנוב׳'));
    await expect(page.locator('body')).not.toContainText('Admin-only note');
    await page.keyboard.press('Escape');
    // Dropping on a greyed day explains instead of opening a proposal.
    await hold(page, '2026-11-03', '2026-11-04', info.project.name === 'mobile');
    await expect(page.locator('[data-sonner-toast]').filter({hasText: t('Casey Cedar can’t take Blair Birch’s day', 'לCasey Cedar אין אפשרות לקחת את התורנות של Blair Birch')})).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await hold(page, '2026-11-03', '2026-11-09', info.project.name === 'mobile');
    await expect(page.getByRole('dialog', {name: t('Propose swap', 'הצעת החלפה')})).toBeVisible();
    await expect(page.getByRole('button', {name: t('Send to both', 'שליחה לשניהם'), exact: true})).toBeEnabled();
  });

  test(`a past day is greyed: it has passed ${lang}`, async ({page, openApp, backend}) => {
    const t = say(lang);
    for (const d of backend.raw.assignments.filter(d => d.day === '2026-11-10' && d.publication_id)) d.primary_id = ids.a;
    await openApp('a');
    await page.clock.setFixedTime(new Date('2026-11-05T10:00:00Z'));
    await page.reload(); await language(page, lang);
    // From 5 November the calendar opens on December.
    await page.getByRole('tab', {name: t('Schedule', 'לוח'), exact: true}).click();
    await page.getByRole('button', {name: t('Previous month', 'חודש קודם')}).click();
    await startSwap(page, '2026-11-10');
    await expectBlocked(page, '2026-11-03', t('This day has passed', 'התורנות הזו כבר עברה'));
    await expectGreen(page, '2026-11-11');
    await expectTapHint(page, '2026-11-03', t('This day has passed', 'התורנות הזו כבר עברה'));
    // Members never ask the server about a past pair.
    expect(backend.calls.filter(c => c.name === 'duty_swap_availability' && c.params.p_to === backend.raw.assignments.find(d => d.day === '2026-11-03' && d.publication_id)!.id)).toHaveLength(0);
  });
}

test('a greyed day is grey once: nothing is green or selectable while checking, and a refetch keeps it grey', async ({page, openApp, backend}) => {
  backend.raw.constraints.push({member_id: ids.a, day: '2026-11-05', kind: 'no', note: ''});
  let release!: () => void;
  backend.availabilityGate = new Promise(r => {release = r;});
  // Controlled timers drive the 30-second team refresh that rechecks the targets.
  await page.clock.install({time: new Date(NOW)});
  await openApp('a');
  await startSwap(page, '2026-11-02');
  // Still checking: neither green nor grey, and a tap neither opens a request nor explains.
  for (const day of ['2026-11-05', '2026-11-12']) {
    await expect(duty(page, day)).toHaveAttribute('data-swap-state', 'pending');
    await expect(duty(page, day)).not.toHaveClass(/drag-target|swap-blocked/);
  }
  await duty(page, '2026-11-05').click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(duty(page, '2026-11-02')).toHaveAttribute('aria-pressed', 'true');
  // Record every class the greyed day takes from here on.
  await duty(page, '2026-11-05').evaluate(cell => {
    const seen: string[] = [];
    (window as unknown as {seen: string[]}).seen = seen;
    new MutationObserver(() => seen.push(cell.className)).observe(cell, {attributes: true, attributeFilter: ['class']});
  });
  release();
  await expect(duty(page, '2026-11-05')).toHaveClass(/swap-blocked/);
  await expect(duty(page, '2026-11-12')).toHaveClass(/drag-target/);
  // A refresh with a new revision rechecks every target without flashing the old answer away.
  const before = backend.calls.filter(c => c.name === 'duty_swap_availability').length;
  backend.availabilityGate = new Promise(r => {release = r;});
  backend.raw.revision!++;
  const loads = backend.calls.filter(c => c.name === 'duty_load').length;
  await page.clock.runFor(30_000);
  await expect.poll(() => backend.calls.filter(c => c.name === 'duty_load').length, 'team refresh').toBeGreaterThan(loads);
  // The recheck is held: the old answer stays on screen meanwhile.
  await expect(duty(page, '2026-11-05')).toHaveClass(/swap-blocked/);
  await expect(duty(page, '2026-11-05')).toHaveAttribute('data-swap-state', 'blocked');
  release();
  await expect.poll(() => backend.calls.filter(c => c.name === 'duty_swap_availability').length).toBeGreaterThan(before);
  await expect(duty(page, '2026-11-05')).toHaveClass(/swap-blocked/);
  const seen = await page.evaluate(() => (window as unknown as {seen: string[]}).seen);
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.filter(c => !/swap-blocked/.test(c) || /drag-target/.test(c)), 'blocked day flashed').toEqual([]);
});

// Owner round 4: the picked duty must read as picked, not as one more green target, in both themes.
for (const scheme of ['light', 'dark'] as const) test(`the picked duty has its own ink ring and a swap mark, unlike the green targets (${scheme})`, async ({page, openApp, backend}) => {
  backend.raw.months[0].status = 'published';
  await page.emulateMedia({colorScheme: scheme});
  await openApp('admin');
  await (await openDutySheet(page, '2026-11-10')).getByRole('button', {name: 'Swap', exact: true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const source = duty(page, '2026-11-10'), target = page.locator('.calendar-grid .drag-target').first();
  await expect(source).toHaveClass(/drag-source/);
  await expect(source.getByRole('img', {name: 'Swapping this duty', exact: true})).toBeVisible();
  await expect(target).toBeVisible();
  const look = await page.evaluate(() => {
    const css = (selector: string) => getComputedStyle(document.querySelector(selector)!);
    const probe = document.createElement('i'); probe.style.color = 'var(--ink)'; document.body.append(probe);
    const ink = getComputedStyle(probe).color; probe.remove();
    return {source: css('.calendar-grid .drag-source').boxShadow, sourceBg: css('.calendar-grid .drag-source').backgroundColor,
      target: css('.calendar-grid .drag-target').boxShadow, targetBg: css('.calendar-grid .drag-target').backgroundColor, ink};
  });
  // An ink ring (dark text colour in light, light in dark), not the targets' green ring or fill.
  expect(look.source).toContain(look.ink);
  expect(look.source).not.toBe(look.target);
  expect(look.sourceBg).not.toBe(look.targetBg);
});
