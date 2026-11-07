import {test, expect, ids, switchLanguage, type Backend} from './fixtures';
import type {Page} from '@playwright/test';
import {existsSync} from 'node:fs';

// Link a new sign-up to a temporary member (decision 2026-11-07): Approve, Link…, Decline on the
// join request; a picker (sheet on phones, side panel on PC, Hebrew panel on the left); a
// confirmation; then the person signs in as the merged member.
const TEMP = '22000000-0000-4000-8000-000000000101', OTHER = '22000000-0000-4000-8000-000000000102', IDLE = '22000000-0000-4000-8000-000000000103';

async function snapshot(page: Page, name: string) {
  test.info().annotations.push({type: 'visual-review', description: JSON.stringify({name: name + '.png', viewport: page.viewportSize(), language: await page.locator('html').getAttribute('lang')})});
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  if (!existsSync(test.info().snapshotPath(name + '.png'))) {
    const path = test.info().outputPath(name + '-actual.png');
    await page.screenshot({path, fullPage: true, animations: 'disabled', caret: 'hide'});
    await test.info().attach(name + '-actual.png', {path, contentType: 'image/png'});
  }
  await expect.soft(page).toHaveScreenshot(name + '.png', {fullPage: true});
}
async function both(page: Page, name: string) {
  await page.emulateMedia({colorScheme: 'light'});
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await snapshot(page, name);
  await page.emulateMedia({colorScheme: 'dark'});
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await snapshot(page, `${name}-dark`);
  await page.emulateMedia({colorScheme: 'light'});
}

/** Dana signed up (pending); the team already has a temporary Dana with a published duty and a
 * swap waiting on her answer, another active temporary member and an inactive one. */
function seed(backend: Backend) {
  const raw = backend.raw, base = raw.members.length;
  Object.assign(raw.members.find(m => m.id === ids.pending)!, {name: 'Dana Levi', language: 'he'});
  raw.members.push(
    {id: TEMP, name: 'Dana', email: null, is_temporary: true, role: 'engineer', status: 'approved', active: true, seniority: base, color: '#e9a2aa'},
    {id: OTHER, name: 'Noam', email: null, is_temporary: true, role: 'engineer', status: 'approved', active: true, seniority: base + 1, color: '#9bcfbe'},
    {id: IDLE, name: 'Rami', email: null, is_temporary: true, role: 'engineer', status: 'approved', active: false, seniority: base + 2, color: '#c9b1de'});
  raw.months[0].status = 'published';
  const live = raw.assignments.filter(a => a.publication_id === raw.months[0].current_publication_id);
  const mine = live.find(a => a.day === '2026-11-03')!, theirs = live.find(a => a.primary_id === ids.b && a.day > '2026-11-03')!;
  mine.primary_id = TEMP;
  raw.swapRequests = [{id: 'request-temporary', month: '2026-11', source_publication_id: mine.publication_id, requester_id: ids.b, other_id: TEMP,
    from_day: theirs.day, from_end_day: theirs.end_day, to_day: mine.day, to_end_day: mine.end_day, explanation: '', status: 'awaiting_engineer',
    accepted_by: null, accepted_at: null, created_at: '2026-10-09T09:00:00Z', resolved_at: null, resolved_by: null, result_publication_id: null, override_reason: '', proposed_by: null, requester_accepted_at: null}];
}
const tab = (page: Page, name: string) => page.getByRole('tab', {name, exact: true});

for (const lang of ['en', 'he'] as const) {
  const t = (en: string, he: string) => lang === 'en' ? en : he;

  test(`admin links a sign-up to a temporary member ${lang}`, async ({page, openApp, backend}, info) => {
    seed(backend);
    await openApp('admin');
    if (lang === 'he') await switchLanguage(page, 'he');
    await tab(page, t('Team', 'צוות')).click();
    const request = page.locator('.membership-request').filter({hasText: 'Dana Levi'});
    await expect(request.getByRole('button')).toHaveText([t('Approve', 'אישור'), t('Link to a temporary member…', 'קישור לחבר צוות זמני…'), t('Decline', 'דחייה')]);
    const before = await request.boundingBox();
    await request.scrollIntoViewIfNeeded();
    await both(page, `link-request-${lang}`);

    // The picker: active temporary members, then the inactive ones in their own group. Keyboard only.
    await request.getByRole('button', {name: t('Link to a temporary member…', 'קישור לחבר צוות זמני…')}).focus();
    await page.keyboard.press('Enter');
    const picker = page.getByRole('dialog', {name: t('Link to a temporary member', 'קישור לחבר צוות זמני')});
    await expect(picker).toBeVisible();
    await expect(picker.getByRole('group')).toHaveCount(2);
    await expect(picker.getByRole('group', {name: t('Temporary members', 'חברי צוות זמניים')}).getByRole('button')).toHaveText([/Dana/, /Noam/]);
    await expect(picker.getByRole('group', {name: t('Inactive', 'לא פעילים')}).getByRole('button')).toHaveText([/Rami/]);
    await expect(picker.getByRole('button', {name: /Dana Levi/})).toHaveCount(0);
    if (info.project.name === 'desktop') {
      // A side panel on PC: on the right in English, on the left in Hebrew.
      const box = (await picker.boundingBox())!, width = page.viewportSize()!.width;
      if (lang === 'he') expect(box.x).toBe(0); else expect(Math.round(box.x + box.width)).toBe(width);
    }
    await both(page, `link-picker-${lang}`);

    // Confirming is a separate step; Escape returns to the picker without linking.
    await picker.getByRole('button', {name: /^Dana ·/}).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText(t('Link Dana Levi\'s sign-up to temporary member Dana?', 'לקשר את ההרשמה של Dana Levi לחבר הצוות הזמני Dana?'));
    await expect(confirm).toContainText('pending@example.invalid');
    await expect(confirm).toContainText(t('Their duties, points, nets and constraints become theirs.', 'הכוננויות, הנקודות, המאזנים והאילוצים של Dana יעברו לDana Levi.'));
    await both(page, `link-confirm-${lang}`);
    await page.keyboard.press('Escape');
    await expect(confirm).toBeHidden();
    await expect(picker).toBeVisible();
    expect(backend.calls.filter(c => c.name === 'duty_link_temporary_member')).toHaveLength(0);

    await picker.getByRole('button', {name: /^Dana ·/}).click();
    await confirm.getByRole('button', {name: t('Link', 'קישור'), exact: true}).click();
    await expect(confirm).toBeHidden();
    await expect(picker).toBeHidden();
    expect(backend.calls.filter(c => c.name === 'duty_link_temporary_member').map(c => c.params)).toEqual([expect.objectContaining({p_pending: ids.pending, p_temporary: TEMP})]);
    await expect(page.locator('.membership-request').filter({hasText: 'Dana Levi'})).toHaveCount(0);
    // Dana keeps her name and colour and is no longer temporary.
    const row = page.locator(`[data-gesture-key="${TEMP}"]`);
    await expect(row).toContainText('Dana');
    await expect(row.getByText(t('Temporary', 'זמני'), {exact: true})).toHaveCount(0);
    expect(before).not.toBeNull();
  });

  test(`decline still works beside link ${lang}`, async ({page, openApp, backend}) => {
    seed(backend);
    await openApp('admin');
    if (lang === 'he') await switchLanguage(page, 'he');
    await tab(page, t('Team', 'צוות')).click();
    const request = page.locator('.membership-request').filter({hasText: 'Dana Levi'});
    await request.scrollIntoViewIfNeeded();
    const box = await request.boundingBox();
    // Opening and closing the picker never moves the request row.
    await request.getByRole('button', {name: t('Link to a temporary member…', 'קישור לחבר צוות זמני…')}).click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    expect(await request.boundingBox()).toEqual(box);
    await request.getByRole('button', {name: t('Decline', 'דחייה'), exact: true}).click();
    await expect(request).toHaveCount(0);
    expect(backend.raw.members.find(m => m.id === ids.pending)?.status).toBe('rejected');
    expect(backend.raw.members.find(m => m.id === TEMP)?.is_temporary).toBe(true);
  });

  test(`the linked sign-in sees the merged member and answers the swap ${lang}`, async ({page, openApp, backend}) => {
    seed(backend);
    // As left by duty_link_temporary_member: the sign-up row is gone, the temporary row owns the sign-in.
    backend.raw.members = backend.raw.members.filter(m => m.id !== ids.pending);
    Object.assign(backend.raw.members.find(m => m.id === TEMP)!, {is_temporary: false, auth_user_id: ids.pending, email: 'pending@example.invalid', language: lang});
    await openApp('pending', page, {waitForReady: false});
    await expect(page.getByRole('button', {name: t('Settings', 'הגדרות'), exact: true})).toBeVisible();
    expect(backend.calls.filter(c => c.name === 'duty_join')).toHaveLength(0);
    const card = page.locator('[data-swap-card]');
    await expect(card.getByRole('button', {name: t('Accept', 'קבלה'), exact: true})).toBeVisible();
    await both(page, `link-signed-in-${lang}`);
    await card.getByRole('button', {name: t('Accept', 'קבלה'), exact: true}).click();
    await expect.poll(() => backend.raw.swapRequests![0].accepted_by).toBe(TEMP);
    expect(backend.calls.filter(c => c.name === 'duty_resolve_swap').map(c => c.user)).toEqual([TEMP]);
  });
}
