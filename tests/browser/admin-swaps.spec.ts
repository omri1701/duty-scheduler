// Admin-proposed swaps: both members accept, then an explicit admin approval.
import type {Browser, Page} from '@playwright/test';
import {test, expect, ids, duty, NOW} from './fixtures';

async function pick(page: Page, from: string, to: string) {
  await duty(page, from).focus(); await page.keyboard.press('Enter');
  await duty(page, to).focus(); await page.keyboard.press('Space');
  await expect(page.getByRole('dialog')).toBeVisible();
}
async function language(page: Page, lang: 'en' | 'he') {
  const toggle = page.getByRole('button', {name: /^Switch to (Hebrew|English)$/});
  await expect(toggle).toBeVisible();
  if (lang === 'he' && await toggle.getAttribute('aria-label') === 'Switch to Hebrew') await toggle.click();
}
async function published(page: Page, lang: 'en' | 'he') {
  await language(page, lang);
  await page.getByRole('button', {name: lang === 'en' ? 'Published' : 'פורסם', exact: true}).click();
}
async function contexts(browser: Browser, page: Page, count: number) {
  return Promise.all(Array.from({length: count}, () => browser.newContext({viewport: page.viewportSize()!, timezoneId: 'Asia/Jerusalem', locale: 'en-GB', serviceWorkers: 'block'})));
}

test('admin proposal needs both members, then an explicit approval with a copyable summary', async ({page, browser, openApp, backend}) => {
  await openApp('admin'); await published(page, 'en');
  // Headless Linux has no system clipboard; capture what the page copies instead.
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', {configurable: true,
    value: {writeText: async (text: string) => {(window as unknown as {copied: string}).copied = text;}}}));
  await pick(page, '2026-11-02', '2026-11-03');
  await expect(page.getByRole('dialog', {name: 'Propose swap'})).toContainText('Both engineers accept first');
  await page.getByLabel('Explanation (optional)').fill('Synthetic coverage change');
  await page.getByRole('button', {name: 'Send to both', exact: true}).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByText('Proposed by you', {exact: true})).toBeVisible();
  await expect(page.getByText('Waiting for: Alex Atlas, Blair Birch', {exact: true})).toBeVisible();
  expect(backend.raw.swapRequests![0]).toMatchObject({requester_id: ids.a, other_id: ids.b, proposed_by: ids.admin, status: 'awaiting_engineer'});
  const [ac, bc] = await contexts(browser, page, 2);
  try {
    const a = await ac.newPage(), b = await bc.newPage();
    await openApp('a', a); await openApp('b', b);
    await expect(a.getByText('Proposed by Avery Admin', {exact: true})).toBeVisible();
    await a.getByRole('button', {name: 'Accept', exact: true}).click();
    await expect(a.getByText('Accepted. Waiting for the other engineer.', {exact: true})).toBeVisible();
    await page.reload();
    await expect(page.getByText('Waiting for: Blair Birch', {exact: true})).toBeVisible();
    await expect(page.getByRole('button', {name: 'Approve', exact: true})).toHaveCount(0);
    await b.reload(); await b.getByRole('button', {name: 'Accept', exact: true}).click();
    await expect(b.getByText('Accepted. Awaiting admin approval.', {exact: true})).toBeVisible();
    // Nothing changes until the final approval.
    expect(backend.raw.publications).toHaveLength(1);
    await page.reload(); await page.getByRole('button', {name: 'Approve', exact: true}).click();
    const dialog = page.getByRole('dialog', {name: 'Approve published swap'});
    await expect(dialog).toContainText('Record this swap in the external system first');
    const summary = ['Duty swap: Alex Atlas ⇄ Blair Birch',
      'Alex Atlas — gives: 2 Nov 2026 (1 pt) · takes: 3 Nov 2026 (1 pt) · change: 0 pts',
      'Blair Birch — gives: 3 Nov 2026 (1 pt) · takes: 2 Nov 2026 (1 pt) · change: 0 pts'].join('\n');
    await expect(dialog.getByLabel('Swap summary')).toHaveText(summary);
    await dialog.getByRole('button', {name: 'Copy summary'}).click();
    await expect(page.getByText('Summary copied.', {exact: true})).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as {copied: string}).copied)).toBe(summary);
    await dialog.getByRole('button', {name: 'Approve & publish swap'}).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('Approved', {exact: true})).toBeVisible();
    await page.reload(); await published(page, 'en');
    await expect(duty(page, '2026-11-02')).toHaveAccessibleName(/Blair Birch/);
    expect(backend.raw.publications.map(p => p.version)).toEqual([1, 2]);
  } finally {await ac.close(); await bc.close();}
});

test('admin as a party: only the other member is asked, and the admin still approves', async ({page, browser, openApp, backend}) => {
  await openApp('admin'); await published(page, 'en');
  // Choosing the other member's duty first still makes the admin's side the request.
  await pick(page, '2026-11-09', '2026-11-08');
  const dialog = page.getByRole('dialog', {name: 'Confirm swap request'});
  await expect(dialog).toContainText('Your duty');
  await dialog.getByRole('button', {name: 'Confirm Request', exact: true}).click();
  await expect(dialog).toBeHidden();
  expect(backend.raw.swapRequests![0]).toMatchObject({requester_id: ids.admin, other_id: ids.a, proposed_by: null, from_day: '2026-11-08'});
  await expect(page.getByRole('button', {name: 'Accept', exact: true})).toHaveCount(0);
  const [ac] = await contexts(browser, page, 1);
  try {
    const a = await ac.newPage(); await openApp('a', a);
    await a.getByRole('button', {name: 'Accept', exact: true}).click();
    await expect(a.getByText('Accepted. Awaiting admin approval.', {exact: true})).toBeVisible();
    await page.reload();
    await expect(page.getByText('Awaiting Admin', {exact: true})).toBeVisible();
    expect(backend.raw.publications).toHaveLength(1);
    await page.getByRole('button', {name: 'Approve', exact: true}).click();
    await page.getByRole('button', {name: 'Approve & publish swap'}).click();
    await expect(page.getByText('Approved', {exact: true})).toBeVisible();
    await page.reload(); await published(page, 'en');
    await expect(duty(page, '2026-11-08')).toHaveAccessibleName(/Alex Atlas/);
  } finally {await ac.close();}
});

for (const lang of ['en', 'he'] as const) test(`a stale approval dialog shows the latest request and cannot approve it ${lang}`, async ({page, openApp, backend}) => {
  const t = (en: string, he: string) => lang === 'en' ? en : he;
  await openApp('admin'); await published(page, lang);
  await pick(page, '2026-11-02', '2026-11-03');
  await page.getByRole('button', {name: t('Send to both', 'שליחה לשניהם'), exact: true}).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  Object.assign(backend.raw.swapRequests![0], {requester_accepted_at: NOW, accepted_by: ids.b, accepted_at: NOW, status: 'awaiting_admin'});
  backend.raw.revision!++;
  await page.reload(); await language(page, lang);
  await page.getByRole('button', {name: t('Approve', 'אישור'), exact: true}).click();
  const dialog = page.getByRole('dialog', {name: t('Approve published swap', 'אישור החלפה בלוח שפורסם')});
  await expect(dialog.getByLabel(t('Swap summary', 'סיכום ההחלפה'))).toContainText('Alex Atlas ⇄ Blair Birch');
  // Another tab's republish handed 3 November to Casey, who has not answered yet.
  Object.assign(backend.raw.swapRequests![0], {other_id: ids.c, accepted_by: null, accepted_at: null, requester_accepted_at: null, status: 'awaiting_engineer'});
  backend.raw.assignments.find(d => d.day === '2026-11-03' && d.publication_id === backend.raw.months[0].current_publication_id)!.primary_id = ids.c;
  backend.failNextSave = true;
  await dialog.getByRole('button', {name: t('Approve & publish swap', 'אישור ופרסום ההחלפה')}).click();
  await expect(dialog.getByRole('alert')).toContainText(t('This request changed and no longer needs this answer.', 'הבקשה השתנתה ואינה ממתינה עוד לתשובה זו.'));
  await expect(dialog.getByLabel(t('Swap summary', 'סיכום ההחלפה'))).toContainText('Alex Atlas ⇄ Casey Cedar');
  await expect(dialog.getByRole('button', {name: t('Approve & publish swap', 'אישור ופרסום ההחלפה')})).toBeDisabled();
  expect(backend.raw.publications).toHaveLength(1);
});

for (const lang of ['en', 'he'] as const) test(`availability alert names whose constraint blocks a swap ${lang}`, async ({page, openApp, backend}) => {
  const t = (en: string, he: string) => lang === 'en' ? en : he;
  await openApp('a'); await language(page, lang);
  // Alex would receive 4 November, which Alex marked unavailable.
  await pick(page, '2026-11-09', '2026-11-04');
  const alert = page.getByRole('dialog').getByRole('alert');
  await expect(alert).toContainText(t('Availability conflict', 'התנגשות זמינות'));
  await expect(alert).toContainText(t('Alex Atlas is unavailable on 4 Nov 2026', 'ל־Alex Atlas יש אילוץ אי־זמינות ב־4 בנוב׳ 2026'));
  await expect(alert).not.toContainText('Synthetic vacation');
  await expect(page.getByRole('button', {name: t('Confirm Request', 'אישור בקשה'), exact: true})).toBeDisabled();
  await page.getByRole('button', {name: t('Cancel', 'ביטול'), exact: true}).click();
  expect(backend.calls.filter(c => c.name === 'duty_request_swap')).toHaveLength(0);
  // Without a conflict the same dialog sends normally.
  await pick(page, '2026-11-02', '2026-11-03');
  await expect(page.getByRole('dialog').getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', {name: t('Confirm Request', 'אישור בקשה'), exact: true})).toBeEnabled();
});

for (const lang of ['en', 'he'] as const) test(`availability is rechecked at consent and final approval ${lang}`, async ({page, browser, openApp, backend}) => {
  const t = (en: string, he: string) => lang === 'en' ? en : he;
  await openApp('admin'); await published(page, lang);
  await pick(page, '2026-11-02', '2026-11-03');
  await expect(page.getByRole('dialog', {name: t('Propose swap', 'הצעת החלפה')})).toBeVisible();
  await page.getByRole('button', {name: t('Send to both', 'שליחה לשניהם'), exact: true}).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  // Blair marks 2 November unavailable after the proposal was sent.
  backend.raw.constraints.push({member_id: ids.b, day: '2026-11-02', kind: 'no', note: 'Late private note'});
  backend.raw.revision!++;
  const [bc] = await contexts(browser, page, 1);
  try {
    const b = await bc.newPage(); await openApp('b', b); await language(b, lang);
    await b.getByRole('button', {name: t('Accept', 'קבלה'), exact: true}).click();
    const consent = b.getByRole('dialog', {name: t('Accept despite a conflict?', 'לאשר למרות התנגשות?')});
    await expect(consent.getByRole('alert')).toContainText(t('Blair Birch is unavailable on 2 Nov 2026', 'ל־Blair Birch יש אילוץ אי־זמינות ב־2 בנוב׳ 2026'));
    await consent.getByRole('button', {name: t('Accept anyway', 'אישור בכל זאת'), exact: true}).click();
    await expect(consent).toBeHidden();
  } finally {await bc.close();}
  // Alex's side, accepted on the server to keep this test on the admin review.
  Object.assign(backend.raw.swapRequests![0], {requester_accepted_at: NOW, status: 'awaiting_admin'});
  backend.raw.revision!++;
  await page.reload(); await language(page, lang);
  await page.getByRole('button', {name: t('Approve', 'אישור'), exact: true}).click();
  const dialog = page.getByRole('dialog', {name: t('Approve published swap', 'אישור החלפה בלוח שפורסם')});
  await expect(dialog.getByLabel(t('Swap summary', 'סיכום ההחלפה'))).toContainText(t('Duty swap: Alex Atlas ⇄ Blair Birch', 'החלפת תורנויות: Alex Atlas ⇄ Blair Birch'));
  await expect(dialog.getByRole('alert')).toContainText(t('Approving requires an explicit override with a reason.', 'האישור מחייב חריגה מפורשת עם נימוק.'));
  const approve = dialog.getByRole('button', {name: t('Approve & publish swap', 'אישור ופרסום ההחלפה')});
  await expect(approve).toBeDisabled();
  await dialog.getByRole('checkbox').check();
  await dialog.getByLabel(t('Required audit reason', 'נימוק חובה לתיעוד')).fill('Recorded in the external system');
  await approve.click();
  await expect(dialog).toBeHidden();
  expect(backend.raw.swapRequests![0]).toMatchObject({status: 'approved', override_reason: 'Recorded in the external system'});
});
