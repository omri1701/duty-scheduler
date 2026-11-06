import {test, expect, switchLanguage} from './fixtures';
import type {Page} from '@playwright/test';
import {existsSync} from 'node:fs';

// Real iPhone CSS widths, plus 300 for Safari page zoom on the smallest one.
const WIDTHS = [300, 375, 390, 393, 402, 430, 440];

// Resizing re-measures in a ResizeObserver and then re-renders; read the result only after both.
async function resize(page: Page, width: number) {
  await page.setViewportSize({width, height: 844});
  for (let i = 0; i < 2; i++) await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 50))));
}

/** The calendar header as a reviewable reference; a missing one is attached for the gallery, as in visual.spec. */
async function region(page: Page, name: string) {
  test.info().annotations.push({type: 'visual-review', description: JSON.stringify({name: name + '.png', viewport: page.viewportSize(), language: await page.locator('html').getAttribute('lang')})});
  await page.evaluate(() => document.fonts.ready);
  const clip = (await page.locator('.calendar-top').boundingBox())!;
  if (!existsSync(test.info().snapshotPath(name + '.png'))) {
    const path = test.info().outputPath(name + '-actual.png');
    await page.screenshot({path, clip, animations: 'disabled', caret: 'hide'});
    await test.info().attach(name + '-actual.png', {path, contentType: 'image/png'});
  }
  await expect.soft(page).toHaveScreenshot(name + '.png', {clip});
}

async function rows(page: Page) {
  return page.locator('.calendar-top').evaluate(top => {
    // Children are vertically centred, so a new row starts only below the previous row's bottom.
    const boxes = [...top.children].map(c => c.getBoundingClientRect()).filter(b => b.height).sort((a, b) => a.top - b.top);
    let count = 0, bottom = -Infinity;
    for (const box of boxes) {if (box.top >= bottom - 1) count++; bottom = Math.max(bottom, box.bottom);}
    return count;
  });
}

for (const reopened of [false, true]) for (const lang of ['en', 'he'] as const)
test(`calendar tools stay on one row on iPhones, ${lang}, ${reopened ? 'reopened draft' : 'new draft'}`, async ({page, backend, openApp}) => {
  if (!reopened) backend.raw.months[0] = {...backend.raw.months[0], current_publication_id: null, status: 'draft'};
  await openApp();
  if (lang === 'he') await switchLanguage(page, 'he');
  const tools = page.locator('.calendar-draft-tools'), buttons = tools.locator('button');
  const names = lang === 'en' ? ['Clear board', 'Special block'] : ['ניקוי הלוח', 'מקטע מיוחד'];
  for (const width of WIDTHS) {
    await resize(page, width);
    // The re-measure lands after the resize: retry the whole reading until it is consistent.
    await expect(async () => {
      // Zoomed past the smallest iPhone, Draft · Published · My duties fill the row: the icons wrap as a pair.
      if (reopened && width < 375) expect(await tools.getAttribute('data-compact')).toBe('');
      else expect(await rows(page), `${width}px`).toBe(1);
      const compact = await tools.getAttribute('data-compact') !== null;
      const boxes = [];
      for (const [i, name] of names.entries()) {
        const button = buttons.nth(i), box = (await button.boundingBox())!;
        boxes.push(box);
        expect(await button.getAttribute('aria-label')).toBe(name);
        expect(box.height).toBeGreaterThanOrEqual(44);
        if (compact) {
          expect(box.width).toBeGreaterThanOrEqual(44);
          expect(await button.getAttribute('title')).toBe(name);
        } else expect(await button.textContent()).toContain(name);
      }
      expect(Math.abs(boxes[0].y - boxes[1].y), `${width}px pair`).toBeLessThan(1);
    }).toPass({timeout: 8_000});
  }
  await resize(page, 390);
  await expect.poll(() => rows(page)).toBe(1);
  await region(page, `iphone-calendar-tools-${reopened ? 'reopened' : 'draft'}-${lang}`);
});

for (const scheme of ['light', 'dark'] as const)
test(`Clear board confirm rests full red on touch, with no sticky hover after a tap, ${scheme} system theme`, async ({page, openApp}) => {
  await page.emulateMedia({colorScheme: scheme});
  await openApp();
  expect(await page.evaluate(() => matchMedia('(hover: none), (pointer: coarse)').matches)).toBe(true);
  await page.locator('.calendar-draft-tools button').first().tap();
  const dialog = page.getByRole('dialog'), confirm = dialog.getByRole('button', {name: 'Clear board', exact: true});
  const red = () => confirm.evaluate(x => getComputedStyle(x).backgroundColor);
  // --destructive (#b83e34), never the faded dark-theme or hover-only shades.
  await expect.poll(red).toBe('rgb(184, 62, 52)');
  // A tap leaves no sticky :hover shade behind: Cancel keeps the board, then the dialog opens again unchanged.
  await confirm.hover();
  await expect.poll(red).toBe('rgb(184, 62, 52)');
  await dialog.getByRole('button', {name: 'Cancel', exact: true}).tap();
  await page.locator('.calendar-draft-tools button').first().tap();
  await expect.poll(red).toBe('rgb(184, 62, 52)');
});
