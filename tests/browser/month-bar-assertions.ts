import {expect, type Page} from '@playwright/test';
import {currentCssHash} from '../../scripts/css-source.mjs';

// Shared by the month-bar spec and the real LOCAL browser smoke test (scripts/verify-local-browser.mjs).
export async function assertMonthBar(page: Page, admin = true) {
  await page.evaluate(() => document.fonts.ready);
  const evidence = await page.evaluate(() => {
    const rect = (el: Element) => {const r = el.getBoundingClientRect(); return {x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom};};
    const bar = document.querySelector('.month-bar')!, title = bar.querySelector('.month-title')!;
    const visible = (el: Element) => el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== 'hidden';
    const buttons = [...bar.querySelectorAll<HTMLButtonElement>('button:not([role=radio])')].filter(visible).map(el => ({text: el.innerText, ...rect(el), clipped: el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1}));
    return {width: innerWidth, hash: getComputedStyle(document.documentElement).getPropertyValue('--duty-css-source').trim(), direction: getComputedStyle(bar).direction,
      bar: rect(bar), title: rect(title), heading: rect(title.querySelector('h2')!), buttons, primary: bar.querySelector('.month-primary') ? rect(bar.querySelector('.month-primary')!) : null,
      menu: bar.querySelector('.month-menu') ? rect(bar.querySelector('.month-menu')!) : null, segmented: bar.querySelector('.seg') ? rect(bar.querySelector('.seg')!) : null, overflow: document.documentElement.scrollWidth > innerWidth};
  });
  // The fingerprint is a quoted CSS string so minifiers cannot rewrite it.
  expect(evidence.hash, 'loaded stylesheet must match this source revision').toBe(`"${await currentCssHash()}"`);
  expect(evidence.overflow).toBe(false);
  if (evidence.width <= 600) expect(Math.abs(evidence.title.x + evidence.title.width / 2 - evidence.bar.x - evidence.bar.width / 2), 'month centred on phones').toBeLessThan(1);
  for (const b of evidence.buttons) {
    expect(b.height, b.text).toBeGreaterThanOrEqual(44);
    expect(b.x, b.text).toBeGreaterThanOrEqual(evidence.bar.x - 1);
    expect(b.right, b.text).toBeLessThanOrEqual(evidence.bar.right + 1);
    expect(b.clipped, b.text).toBe(false);
  }
  if (evidence.segmented) expect(evidence.segmented.height, 'the version switch is a 44px control').toBeGreaterThanOrEqual(44);
  for (let i = 0; i < evidence.buttons.length; i++) for (let j = i + 1; j < evidence.buttons.length; j++) {
    const a = evidence.buttons[i], b = evidence.buttons[j];
    expect(a.right <= b.x + 1 || b.right <= a.x + 1 || a.bottom <= b.y + 1 || b.bottom <= a.y + 1, `overlap: ${a.text}/${b.text}`).toBe(true);
  }
  if (admin) {
    expect(evidence.primary, 'one primary action').not.toBeNull();
    expect(evidence.menu, 'the ⋯ menu').not.toBeNull();
    expect(Math.abs(evidence.primary!.y - evidence.menu!.y), 'primary and menu share a row').toBeLessThan(1);
  }
  return evidence;
}

export async function assertMonthMenu(page: Page, touch = false) {
  const trigger = page.getByRole('button', {name: /^(Month actions|פעולות לחודש)$/});
  await trigger.focus();
  if (touch) await trigger.tap(); else await page.keyboard.press('Enter');
  const menu = page.getByRole('menu'); await expect(menu).toBeVisible();
  const evidence = await menu.evaluate(el => {
    const css = getComputedStyle(el), r = el.getBoundingClientRect();
    const items = [...el.querySelectorAll('[role=menuitem]')].map(item => {const r = item.getBoundingClientRect(); return {height: r.height, topmost: el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))};});
    return {background: css.backgroundColor, dpr: devicePixelRatio, shadow: css.boxShadow, z: css.zIndex, left: r.left, right: r.right, top: r.top, bottom: r.bottom, viewport: {width: innerWidth, height: innerHeight}, items};
  });
  expect(evidence.background).not.toBe('rgba(0, 0, 0, 0)');
  expect(evidence.shadow).not.toBe('none'); expect(Number(evidence.z)).toBeGreaterThanOrEqual(60);
  expect(evidence.left).toBeGreaterThanOrEqual(10); expect(evidence.right).toBeLessThanOrEqual(evidence.viewport.width - 10);
  expect(evidence.top).toBeGreaterThanOrEqual(0); expect(evidence.bottom).toBeLessThanOrEqual(evidence.viewport.height);
  for (const item of evidence.items) {expect(item.height).toBeGreaterThanOrEqual(44); expect(item.topmost).toBe(true);}
  await page.keyboard.press('Escape'); await expect(trigger).toBeFocused();
  return evidence;
}

