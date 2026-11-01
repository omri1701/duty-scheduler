import {expect, type Page} from '@playwright/test';
import {currentCssHash} from '../../scripts/css-source.mjs';

// Shared by fixture coverage and the real LOCAL browser smoke test.
export async function assertToolbar(page: Page) {
  await expect(page.locator('.workflow-actions')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const evidence = await page.evaluate(() => {
    const selectors = ['.month-toolbar', '.desktop-month-tools', '.month-actions-menu', '.workflow-actions', '.workflow-label'];
    const rect = (el: Element) => {const r = el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
    const computed = Object.fromEntries(selectors.map(selector => {
      const el = document.querySelector(selector);
      return [selector, el ? {display:getComputedStyle(el).display, ...rect(el)} : null];
    }));
    const visible = (el: Element) => el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== 'hidden';
    const toolbar = document.querySelector('.month-toolbar')!;
    const buttons = [...toolbar.querySelectorAll('button')].filter(visible).map(el => ({text:el.innerText,...rect(el),clipped:el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1}));
    const labels = [...toolbar.querySelectorAll('.workflow-label')].filter(visible);
    return {width:innerWidth, containerWidth:toolbar.parentElement!.getBoundingClientRect().width, direction:getComputedStyle(toolbar).direction,
      hash:getComputedStyle(document.documentElement).getPropertyValue('--duty-css-source').trim(),
      computed, toolbar:rect(toolbar), title:rect(toolbar.querySelector('h2')!),
      navigation:rect(toolbar.querySelector('.month-title')!), buttons,
      workflows:[...toolbar.querySelectorAll('.workflow-actions>button')].map(el=>({...rect(el),paddingStart:Number.parseFloat(getComputedStyle(el).paddingInlineStart),paddingEnd:Number.parseFloat(getComputedStyle(el).paddingInlineEnd)})),
      visibleLabels:labels.length, overflow:document.documentElement.scrollWidth > innerWidth};
  });
  // The fingerprint is a quoted CSS string so minifiers cannot rewrite it.
  expect(evidence.hash, 'loaded stylesheet must match this source revision').toBe(`"${await currentCssHash()}"`);
  expect(evidence.computed['.month-toolbar']?.display).toBe('grid');
  const desktop = evidence.containerWidth >= 960;
  expect(evidence.computed['.desktop-month-tools']?.display).toBe(desktop ? 'flex' : 'none');
  expect(evidence.computed['.month-actions-menu']?.display).toBe(desktop ? 'none' : 'flex');
  expect(evidence.computed['.workflow-actions']?.display).toBe('flex');
  await expect(page.locator('.month-title button').first().locator('svg')).toHaveClass(new RegExp(evidence.direction==='rtl'?'lucide-chevron-right':'lucide-chevron-left'));
  const generating = await page.locator('.generate-month-action').count() > 0;
  if (generating) {
    expect(evidence.visibleLabels, 'one visible Generate/Review plan label').toBe(1);
  }
  if (await page.locator('.cancel-draft-action').count()) expect(evidence.workflows).toHaveLength(3);
  expect(Math.abs(evidence.title.x + evidence.title.width / 2 - evidence.toolbar.x - evidence.toolbar.width / 2), 'month centered in content').toBeLessThan(1);
  expect(evidence.overflow).toBe(false);
  const actionY = evidence.workflows[0].y;
  for (const r of evidence.workflows) expect(Math.abs(r.y - actionY), 'workflow buttons on one row').toBeLessThan(1);
  for (const r of evidence.workflows) for(const padding of [r.paddingStart,r.paddingEnd]) {
    expect(padding,'comfortable padding on both sides').toBeGreaterThanOrEqual(evidence.containerWidth<=310?7:9);
  }
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

export async function assertMonthMenu(page: Page, touch = false) {
  const trigger=page.locator('.month-actions-menu');
  await trigger.focus();
  if(touch)await trigger.tap();else await page.keyboard.press('Enter');
  const menu=page.getByRole('menu');await expect(menu).toBeVisible();
  const evidence=await menu.evaluate(el=>{
    const css=getComputedStyle(el),r=el.getBoundingClientRect();
    const items=[...el.querySelectorAll('[role=menuitem]')].map(item=>{
      const r=item.getBoundingClientRect();return {height:r.height,topmost:el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};
    });
    return {background:css.backgroundColor,border:css.borderTopWidth,dpr:devicePixelRatio,shadow:css.boxShadow,z:css.zIndex,left:r.left,right:r.right,top:r.top,bottom:r.bottom,viewport:{width:innerWidth,height:innerHeight},items};
  });
  expect(evidence.background).toBe('rgb(255, 255, 255)');
  expect(Math.round(Number.parseFloat(evidence.border)*evidence.dpr),'visible border at actual browser zoom').toBeGreaterThanOrEqual(1);
  expect(evidence.shadow).not.toBe('none');expect(Number(evidence.z)).toBeGreaterThanOrEqual(60);
  expect(evidence.left).toBeGreaterThanOrEqual(15);expect(evidence.right).toBeLessThanOrEqual(evidence.viewport.width-15);
  expect(evidence.top).toBeGreaterThanOrEqual(0);expect(evidence.bottom).toBeLessThanOrEqual(evidence.viewport.height);
  for(const item of evidence.items){expect(item.height).toBeGreaterThanOrEqual(44);expect(item.topmost).toBe(true);}
  await page.keyboard.press('Escape');await expect(trigger).toBeFocused();
  return evidence;
}
