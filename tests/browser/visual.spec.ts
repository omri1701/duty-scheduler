import {test, expect, monthAction, duty, keyboardRequest, confirmRequest} from './fixtures';
import type {Page} from '@playwright/test';
import {PROJECTS} from '../../lib/supabase/environment';

// Retain the deployed Production baseline (no badge). Environment-specific
// headers/access states have their own new snapshots in environment.spec.ts.
test.beforeEach(({backend})=>{backend.url=PROJECTS.prod;backend.runtimeOrigin='https://duty-scheduler-prod.vercel.app';});

async function snapshot(page: Page, name: string) {
  test.info().annotations.push({type:'visual-review',description:JSON.stringify({name:name+'.png',viewport:page.viewportSize(),language:await page.locator('html').getAttribute('lang')})});
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  // Collect every visual difference while retaining a failing test result.
  await expect.soft(page).toHaveScreenshot(name + '.png', {fullPage: true});
}

test('access states', async ({page, openApp}) => {
  await openApp('signed-out'); await snapshot(page, 'signed-out');
  await page.getByRole('button', {name: 'עברית', exact: true}).click();
  await expect(page.locator('main')).toHaveAttribute('dir', 'rtl');
  await snapshot(page, 'signed-out-he');
});
test('published swap confirmation and outgoing request', async ({page, openApp}) => {
  await openApp('a'); await keyboardRequest(page); await snapshot(page, 'swap-confirmation-en');
  await confirmRequest(page); await page.getByText('Awaiting Engineer', {exact: true}).waitFor();
  // Wait for the transient success toast without altering application styles.
  await expect(page.getByText('Swap request submitted.', {exact: true})).toBeHidden({timeout: 10_000});
  await snapshot(page, 'swap-request-en');
});
test('pending approval', async ({page, openApp}) => {
  await openApp('pending'); await snapshot(page, 'pending-approval');
});
test('draft calendar, editor, history and Hebrew RTL', async ({page, openApp}) => {
  await openApp(); await snapshot(page, 'admin-draft-en');
  await duty(page, '2026-11-02').click(); await snapshot(page, 'duty-editor-en');
  await page.keyboard.press('Escape');
  await monthAction(page, 'Versions'); await snapshot(page, 'version-history-en');
  await page.keyboard.press('Escape');
  await page.getByRole('button', {name: 'Switch to Hebrew'}).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl'); await snapshot(page, 'admin-draft-he');
});
test('engineer publication and availability', async ({page, openApp, backend}) => {
  await openApp('a'); await snapshot(page, 'engineer-published-en');
  await page.getByRole('button', {name: 'Switch to Hebrew'}).click(); await snapshot(page, 'engineer-published-he');
  await page.getByRole('button', {name: 'Switch to English'}).click();
  backend.raw.months[0].current_publication_id = null;
  await page.reload(); await page.getByRole('tab', {name: 'Availability', exact: true}).click();
  await snapshot(page, 'engineer-availability-en');
});

test('phone availability sheet and team in English and Hebrew', async ({page, openApp}, info) => {
  test.skip(info.project.name !== 'mobile', 'Phone-only design.');
  await openApp();
  for (const lang of ['en', 'he']) {
    if (lang === 'he') await page.getByRole('button', {name: 'Switch to Hebrew'}).click();
    await page.getByRole('tab').nth(1).click();
    await page.locator('.availability-day[data-gesture-key="2026-11-05"]').click();
    await snapshot(page, `availability-sheet-${lang}`);
    await page.keyboard.press('Escape');
    await page.getByRole('tab').nth(2).click();
    await snapshot(page, `team-${lang}`);
  }
});
