import {expect, type Page} from '@playwright/test';
import {currentCssHash} from '../../scripts/css-source.mjs';

// Shared by fixture coverage and the real LOCAL browser smoke test.
export async function assertToolbar(page: Page) {
  await expect(page.locator('.workflow-actions')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const evidence = await page.evaluate(() => {
    const selectors = ['.month-toolbar', '.desktop-month-tools', '.month-actions-menu', '.workflow-actions', '.workflow-label-wide', '.workflow-label-compact'];
    const rect = (el: Element) => {const r = el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
    const computed = Object.fromEntries(selectors.map(selector => {
      const el = document.querySelector(selector);
      return [selector, el ? {display:getComputedStyle(el).display, ...rect(el)} : null];
    }));
    const visible = (el: Element) => el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== 'hidden';
    const toolbar = document.querySelector('.month-toolbar')!;
    const buttons = [...toolbar.querySelectorAll('button')].filter(visible).map(el => ({text:el.innerText,...rect(el),clipped:el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1}));
    const labels = [...toolbar.querySelectorAll('.workflow-label-wide,.workflow-label-compact')].filter(visible);
    return {width:innerWidth, direction:getComputedStyle(toolbar).direction,
      hash:getComputedStyle(document.documentElement).getPropertyValue('--duty-css-source').trim(),
      computed, toolbar:rect(toolbar), title:rect(toolbar.querySelector('h2')!),
      navigation:rect(toolbar.querySelector('.month-title')!), buttons,
      workflows:[...toolbar.querySelectorAll('.workflow-actions>button')].map(rect),
      visibleLabels:labels.length, overflow:document.documentElement.scrollWidth > innerWidth};
  });
  expect(evidence.hash, 'loaded stylesheet must match this source revision').toBe(await currentCssHash());
  expect(evidence.computed['.month-toolbar']?.display).toBe('grid');
  const desktop = evidence.width >= 1024;
  expect(evidence.computed['.desktop-month-tools']?.display).toBe(desktop ? 'flex' : 'none');
  expect(evidence.computed['.month-actions-menu']?.display).toBe(desktop ? 'none' : 'flex');
  expect(evidence.computed['.workflow-actions']?.display).toBe(desktop ? 'flex' : 'grid');
  const generating = await page.locator('.generate-month-action').count() > 0;
  if (generating) {
    expect(evidence.visibleLabels, 'one visible Generate/Regenerate label').toBe(1);
    expect(evidence.computed[desktop ? '.workflow-label-compact' : '.workflow-label-wide']?.display).toBe('none');
  }
  if (await page.locator('.cancel-draft-action').count()) expect(evidence.workflows).toHaveLength(3);
  expect(Math.abs(evidence.title.x + evidence.title.width / 2 - evidence.toolbar.x - evidence.toolbar.width / 2), 'month centered in content').toBeLessThan(1);
  expect(evidence.overflow).toBe(false);
  const actionY = evidence.workflows[0].y;
  for (const r of evidence.workflows) expect(Math.abs(r.y - actionY), 'workflow buttons on one row').toBeLessThan(1);
  const ellipsis = evidence.computed['.month-actions-menu']!;
  if (!desktop) {
    expect(Math.abs(ellipsis.y - actionY), 'ellipsis shares the workflow row').toBeLessThan(1);
    expect(evidence.navigation.bottom).toBeLessThanOrEqual(actionY);
    expect(new Set(evidence.buttons.map(b => Math.round(b.y))).size, 'exactly two toolbar rows').toBe(2);
  } else {
    for (const b of evidence.buttons) expect(Math.abs(b.y - actionY), 'all desktop controls share one row').toBeLessThan(1);
  }
  for (const b of evidence.buttons) {
    expect(b.height, b.text).toBeGreaterThanOrEqual(44);
    expect(b.x, b.text).toBeGreaterThanOrEqual(evidence.toolbar.x - 1);
    expect(b.right, b.text).toBeLessThanOrEqual(evidence.toolbar.right + 1);
    expect(b.clipped, b.text).toBe(false);
    const title = evidence.title;
    expect(b.right <= title.x + 1 || title.right <= b.x + 1 || b.bottom <= title.y + 1 || title.bottom <= b.y + 1, `month title overlaps ${b.text}`).toBe(true);
  }
  for (let i=0;i<evidence.buttons.length;i++) for (let j=i+1;j<evidence.buttons.length;j++) {
    const a=evidence.buttons[i], b=evidence.buttons[j];
    expect(a.right <= b.x + 1 || b.right <= a.x + 1 || a.bottom <= b.y + 1 || b.bottom <= a.y + 1, `overlap: ${a.text}/${b.text}`).toBe(true);
  }
  if (!desktop) {
    const workflow = await page.locator('.workflow-actions').boundingBox();
    expect(evidence.direction === 'ltr' ? ellipsis.right <= workflow!.x : ellipsis.x >= workflow!.x + workflow!.width).toBe(true);
  }
  return evidence;
}
