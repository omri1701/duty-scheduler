import {test, expect, monthAction, duty, keyboardRequest, confirmRequest, ids} from './fixtures';
import type {Page} from '@playwright/test';
import {PROJECTS} from '../../lib/supabase/environment';
import {existsSync} from 'node:fs';

// Retain the deployed Production baseline (no badge). Environment-specific
// headers/access states have their own new snapshots in environment.spec.ts.
test.beforeEach(({backend})=>{backend.url=PROJECTS.prod;backend.runtimeOrigin='https://duty-scheduler-prod.vercel.app';});

async function snapshot(page: Page, name: string, keepPointer = false) {
  test.info().annotations.push({type:'visual-review',description:JSON.stringify({name:name+'.png',viewport:page.viewportSize(),language:await page.locator('html').getAttribute('lang')})});
  await page.evaluate(() => document.fonts.ready);
  if (!keepPointer) await page.mouse.move(0, 0);
  // With updateSnapshots:none Playwright reports missing references without an
  // actual attachment. Retain the candidate explicitly for the review gallery.
  if(!existsSync(test.info().snapshotPath(name+'.png'))) {
    const path=test.info().outputPath(name+'-actual.png');
    await page.screenshot({path,fullPage:true,animations:'disabled',caret:'hide'});
    await test.info().attach(name+'-actual.png',{path,contentType:'image/png'});
  }
  // Collect every visual difference while retaining a failing test result.
  await expect.soft(page).toHaveScreenshot(name + '.png', {fullPage: true});
}

for(const lang of ['en','he'])test(`today accent in combined weekend ${lang}`,async({page,openApp})=>{
  await openApp();
  await page.clock.setFixedTime(new Date('2026-11-07T12:00:00Z'));
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  if(lang==='he')await page.getByRole('button',{name:'Switch to Hebrew',exact:true}).click();
  await expect(duty(page,'2026-11-06').locator('[aria-current="date"]')).toHaveText('7');
  await snapshot(page,`today-weekend-draft-${lang}`);
  await page.getByRole('button',{name:lang==='en'?'Published':'פורסם',exact:true}).click();
  await snapshot(page,`today-weekend-published-${lang}`);
});

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

for(const lang of ['en','he'])test(`manager publishing controls ${lang}`,async({page,openApp,backend})=>{
  backend.raw.months[0].status='published';
  await openApp();
  if(lang==='he')await page.getByRole('button',{name:'Switch to Hebrew',exact:true}).click();
  const button=(en:string,he:string)=>page.getByRole('button',{name:lang==='en'?en:he,exact:true});
  await snapshot(page,`manager-published-${lang}`);
  await button('Next month','חודש הבא').click();
  await snapshot(page,`manager-new-${lang}`);
  await button('Previous month','חודש קודם').click();
  await button('Reopen draft','פתיחת טיוטה').click();
  await button('Published','פורסם').click();
  await button('My duties','התורנויות שלי').click();
  await snapshot(page,`manager-reopened-published-${lang}`);
  await button('Cancel draft','ביטול טיוטה').click();
  await snapshot(page,`manager-cancel-draft-${lang}`);
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

for (const lang of ['en', 'he']) test(`plan the month pie ${lang}`, async ({page, openApp, backend}, info) => {
  backend.raw.assignments = []; backend.raw.publications = [];
  backend.raw.months[0] = {...backend.raw.months[0], current_publication_id: null, status: 'draft', generated: false};
  // One locked duty, so the pie total and the hover details both show locked points.
  backend.raw.assignments.push({id: 'locked', publication_id: null, day: '2026-11-10', end_day: '2026-11-11', primary_id: ids.admin, secondary_id: null, title: '', extra_points: 0, points: 1, locked: true, manager_override: false});
  await openApp();
  const he = lang === 'he', dialog = page.getByRole('dialog');
  if (he) await page.getByRole('button', {name: 'Switch to Hebrew', exact: true}).click();
  await page.getByRole('button', {name: he ? 'יצירת שיבוץ' : 'Generate month', exact: true}).click();
  await expect(dialog.getByRole('button', {name: he ? 'אישור ושיבוץ' : 'Confirm & generate', exact: true})).toBeEnabled({timeout: 30_000});
  // Park the emulated mouse: a row opening under it would read as hovered.
  await page.mouse.move(0, 0);
  // The total names the locked points without an icon.
  await expect(dialog.locator('.plan-pie-total small')).toHaveText(he ? '1 נעולות' : '1 locked');
  await expect(dialog.locator('.plan-pie-center svg')).toHaveCount(0);
  await snapshot(page, `plan-month-${lang}`);
  // A temporary change shows its chip; the pie centre shows the slice in focus.
  await dialog.getByRole('button', {name: `${he ? 'הפחתת זמני' : 'Decrease Temporary'} · Avery Admin`, exact: true}).click();
  const slice = dialog.locator(`.plan-slice[data-engineer="${ids.admin}"]`);
  if (info.project.name === 'mobile') await slice.tap(); else await slice.hover();
  await expect(slice).toHaveClass(/active/);
  // The hover details carry a small lock beside the locked points.
  const lock = (await dialog.locator('.plan-pie-detail li.locked svg').boundingBox())!;
  expect(lock.width).toBeLessThanOrEqual(10); expect(lock.height).toBeLessThanOrEqual(10);
  await snapshot(page, `plan-month-pie-hover-${lang}`, true);
  await dialog.getByRole('button', {name: he ? 'שמירה' : 'Save', exact: true}).click();
  await expect(dialog.getByRole('button', {name: he ? 'נשמר' : 'Saved', exact: true})).toBeDisabled();
  await dialog.locator('.allocation-details summary').click();
  await dialog.locator('.allocation-scroll').evaluate(el => {el.scrollTop = el.scrollHeight;});
  await snapshot(page, `plan-month-details-${lang}`);
  // The app has no dark theme of its own; this checks that the OS preference leaves the dialog intact.
  await page.emulateMedia({colorScheme: 'dark'});
  await dialog.locator('.allocation-scroll').evaluate(el => {el.scrollTop = 0;});
  await snapshot(page, `plan-month-dark-${lang}`);
});

/** A clipped reference: Generate's fresh seed varies the calendar, so only the
 * deterministic plan and toolbar areas are compared. */
async function region(page: Page, name: string, clip: {x: number; y: number; width: number; height: number}) {
  test.info().annotations.push({type:'visual-review',description:JSON.stringify({name:name+'.png',viewport:page.viewportSize(),language:await page.locator('html').getAttribute('lang')})});
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  if(!existsSync(test.info().snapshotPath(name+'.png'))) {
    const path=test.info().outputPath(name+'-actual.png');
    await page.screenshot({path,clip,fullPage:true,animations:'disabled',caret:'hide'});
    await test.info().attach(name+'-actual.png',{path,contentType:'image/png'});
  }
  await expect.soft(page).toHaveScreenshot(name + '.png', {clip, fullPage: true});
}

for (const lang of ['en', 'he']) test(`after Generate the plan is the review ${lang}`, async ({page, openApp, backend}) => {
  backend.raw.assignments = []; backend.raw.publications = [];
  backend.raw.months[0] = {...backend.raw.months[0], current_publication_id: null, status: 'draft', generated: false};
  await openApp();
  const he = lang === 'he', dialog = page.getByRole('dialog');
  if (he) await page.getByRole('button', {name: 'Switch to Hebrew', exact: true}).click();
  await page.getByRole('button', {name: he ? 'יצירת שיבוץ' : 'Generate month', exact: true}).click();
  const confirm = dialog.getByRole('button', {name: he ? 'אישור ושיבוץ' : 'Confirm & generate', exact: true});
  await expect(confirm).toBeEnabled({timeout: 30_000});
  await confirm.click();
  await expect(dialog).toBeHidden({timeout: 50_000});
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0, {timeout: 15_000});
  // A saved plan change after Generate: Avery takes one point less.
  await page.getByRole('button', {name: he ? 'בדיקת התוכנית' : 'Review plan', exact: true}).click();
  await expect(confirm).toBeEnabled({timeout: 30_000});
  await dialog.getByRole('button', {name: `${he ? 'הפחתת זמני' : 'Decrease Temporary'} · Avery Admin`, exact: true}).click();
  await dialog.getByRole('button', {name: he ? 'שמירה' : 'Save', exact: true}).click();
  await expect(dialog.getByRole('button', {name: he ? 'נשמר' : 'Saved', exact: true})).toBeDisabled();
  await expect(dialog.locator('.allocation-row-warning')).not.toHaveCount(0);
  await region(page, `plan-review-${lang}`, (await dialog.boundingBox())!);
  await page.keyboard.press('Escape'); await expect(dialog).toBeHidden();
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0, {timeout: 15_000});
  const note = page.locator('.publish-blocked-note');
  await expect(note).toBeVisible();
  const top = (await page.locator('.month-toolbar-container').boundingBox())!, bottom = (await note.boundingBox())!;
  await region(page, `publish-waits-${lang}`, {x: 0, y: top.y, width: page.viewportSize()!.width, height: bottom.y + bottom.height - top.y + 8});
});
