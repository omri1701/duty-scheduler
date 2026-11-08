import {test, expect, seed, switchLanguage, monthAction} from './fixtures';
import {webkit, devices} from '@playwright/test';
import {assertMonthBar, assertMonthMenu} from './month-bar-assertions';
import {zoomContext, setBrowserZoom} from './zoom-context.mjs';

// The month bar (decision 2026-11-06): the served CSS is this revision, one primary action and a
// ⋯ menu for admins, the title centred on phones, 44px targets, nothing clipped or overflowing.
const managerStates = ['reopened', 'published', 'new', 'generated'] as const;
function managerMonth(state: typeof managerStates[number]) {
  const raw = seed();
  if (state === 'published') raw.months[0].status = 'published';
  if (state === 'new' || state === 'generated') {
    raw.months[0].current_publication_id = null; raw.months[0].publication_sequence = 0;
    raw.months[0].generated = state === 'generated'; raw.publications = [];
    raw.assignments = state === 'new' ? [] : raw.assignments.filter(d => d.publication_id === null);
  }
  return raw;
}
const primaryFor = {reopened: ['Review plan', 'Publish'], published: ['Reopen'], new: ['Plan the month'], generated: ['Review plan', 'Publish']} as const;

test('iPhone WebKit: every manager state keeps the primary action and menu on one row', async ({backend, openApp}, info) => {
  test.skip(info.project.name !== 'desktop', 'One independent iPhone WebKit context.');
  const browser = await webkit.launch();
  try {
    const context = await browser.newContext({...devices['iPhone 13'], locale: 'en-GB', timezoneId: 'Asia/Jerusalem', reducedMotion: 'reduce'});
    for (const state of managerStates) {
      backend.raw = managerMonth(state);
      const page = await context.newPage(); await openApp('admin', page);
      await page.getByRole('tab', {name: 'Schedule', exact: true}).click();
      for (const lang of ['en', 'he'] as const) {
        if (lang === 'he') await switchLanguage(page, 'he');
        for (const width of [375, 390, 430]) {
          await page.setViewportSize({width, height: 844});
          const evidence = await assertMonthBar(page);
          if (lang === 'en') expect(primaryFor[state]).toContain(evidence.buttons.find(b => b.width === evidence.primary!.width && b.x === evidence.primary!.x)!.text.trim());
          expect(evidence.heading.bottom).toBeLessThanOrEqual(evidence.primary!.y + 1);
          if (width === 375) await assertMonthMenu(page);
        }
        await info.attach(`iphone-${state}-${lang}`, {body: await page.screenshot({fullPage: true}), contentType: 'image/png'});
      }
      await page.close();
    }
  } finally {await browser.close();}
});

test('desktop widths keep the bar on one row with keyboard-reachable menu items in all manager states', async ({page, backend, openApp}) => {
  test.skip(test.info().project.name !== 'desktop', 'Desktop responsive matrix runs once.');
  for (const state of managerStates) {
    backend.raw = managerMonth(state); await openApp();
    await page.getByRole('tab', {name: 'Schedule', exact: true}).click();
    for (const lang of ['en', 'he'] as const) {
      if (lang === 'he') await switchLanguage(page, 'he');
      for (const width of [1024, 1280, 1440]) {
        await page.setViewportSize({width, height: 1000});
        const evidence = await assertMonthBar(page);
        for (const b of evidence.buttons) expect(Math.abs(b.y - evidence.buttons[0].y), 'all desktop controls share one row').toBeLessThan(1);
      }
      for (const name of [lang === 'en' ? 'Versions' : 'גרסאות', lang === 'en' ? 'Constraints deadline' : 'מועד אחרון לאילוצים']) {
        await monthAction(page, name);
        await expect(page.getByRole('dialog')).toBeVisible(); await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).toBeHidden();
      }
    }
  }
});

test('engineers see the month bar without actions', async ({page, openApp}) => {
  await openApp('a');
  await page.getByRole('tab', {name: 'Schedule', exact: true}).click();
  const evidence = await assertMonthBar(page, false);
  expect(evidence.primary).toBeNull(); expect(evidence.menu).toBeNull();
  await expect(page.getByRole('button', {name: 'Month actions', exact: true})).toHaveCount(0);
});

test('actual browser zoom keeps the bar and menu usable', async ({backend, openApp}, info) => {
  test.skip(info.project.name !== 'desktop', 'One isolated browser zoom matrix.');
  test.setTimeout(120_000);
  const context = await zoomContext();
  try {
    const page = await context.newPage();
    for (const state of ['new', 'published', 'reopened'] as const) {
      backend.raw = managerMonth(state);
      await openApp('admin', page);
      await page.getByRole('tab', {name: 'Schedule', exact: true}).click();
      for (const width of [1024, 1440]) {
        await page.setViewportSize({width, height: 1000});
        for (const zoom of [1, 1.5, 2]) {
          expect(await setBrowserZoom(context, page, zoom)).toBe(zoom);
          for (const lang of ['en', 'he'] as const) {
            if (lang === 'he') await switchLanguage(page, 'he');
            await assertMonthBar(page);
            await assertMonthMenu(page);
            if (lang === 'he') await switchLanguage(page, 'en');
          }
        }
        await setBrowserZoom(context, page, 1);
      }
    }
  } finally {await context.close();}
});

for (const scheme of ['light', 'dark'] as const)
test(`Clear board confirm rests full red on touch, with no sticky hover after a tap, ${scheme} system theme`, async ({page, openApp}, info) => {
  test.skip(info.project.name !== 'mobile', 'Touch-only hover rule.');
  await page.emulateMedia({colorScheme: scheme});
  await openApp();
  await page.getByRole('tab', {name: 'Schedule', exact: true}).click();
  expect(await page.evaluate(() => matchMedia('(hover: none), (pointer: coarse)').matches)).toBe(true);
  const open = async () => {await page.getByRole('button', {name: 'Month actions', exact: true}).tap(); await page.getByRole('menuitem', {name: 'Clear board', exact: true}).click();};
  await open();
  const dialog = page.getByRole('alertdialog'), confirm = dialog.getByRole('button', {name: 'Clear board', exact: true});
  const red = () => confirm.evaluate(x => getComputedStyle(x).backgroundColor);
  const expected = scheme === 'dark' ? 'rgb(255, 107, 94)' : 'rgb(192, 41, 31)';
  await expect.poll(red).toBe(expected);
  await confirm.hover();
  await expect.poll(red).toBe(expected);
  await dialog.getByRole('button', {name: 'Cancel', exact: true}).tap();
  await expect(dialog).toBeHidden();
  await open();
  await expect.poll(red).toBe(expected);
});
