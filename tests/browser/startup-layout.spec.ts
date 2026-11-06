import {test, expect} from './fixtures';

// The startup shell (decision 2026-11-06): the sidebar or tab bar, header and Home placeholders
// hold the final geometry, so the verified screen never shifts them; only placeholders pulse.
async function geometry(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const box = (el: Element) => {const r = el.getBoundingClientRect(); return {x: r.x, y: r.y, width: r.width, height: r.height};};
    const elements = Object.fromEntries(['.side', '.side-item', '.hdr', '.hdr-actions', '.tabbar', '.mobile-navigation', '.mobile-nav-selection', '.mobile-navigation [data-slot=tabs-trigger]', '.home-head', '.hero']
      .map(selector => [selector, [...document.querySelectorAll(selector)].map(box)]));
    return {elements, overflow: document.documentElement.scrollWidth - innerWidth};
  });
}
function close(actual: number, expected: number, description: string) {expect(Math.abs(actual - expected), description).toBeLessThan(.1);}

for (const width of [320, 390, 430, 768, 1440]) for (const lang of ['en', 'he'] as const) {
  test(`public/verified shell geometry ${width}px ${lang}`, async ({page, openApp, backend}, info) => {
    test.skip(info.project.name !== 'desktop', 'Run the geometry matrix once.');
    await page.setViewportSize({width, height: 900});
    backend.url = 'http://127.0.0.1:54321'; backend.runtimeOrigin = 'http://localhost:8787';
    await openApp('signed-out');
    if (lang === 'he') await page.getByRole('button', {name: 'עברית', exact: true}).click();
    let release!: () => void; backend.authGate = new Promise<void>(resolve => {release = resolve;});
    await page.locator('input[type=password]').fill('synthetic-only');
    await page.locator('form.local-login button[type=submit]').click();
    let shell!: Awaited<ReturnType<typeof geometry>>;
    try {
      await expect(page.locator('.startup-skeleton')).toBeVisible();
      await expect(page.locator('.startup-skeleton')).toHaveAttribute('dir', lang === 'he' ? 'rtl' : 'ltr');
      await expect(page.locator('[data-settings-button]')).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      shell = await geometry(page);
      await info.attach('shell', {body: await page.screenshot({fullPage: true}), contentType: 'image/png'});
    } finally {release();}
    await expect(page.locator('[data-settings-button]')).toBeVisible();
    const real = await geometry(page);
    await info.attach('real', {body: await page.screenshot({fullPage: true}), contentType: 'image/png'});
    expect(real.overflow).toBe(0);
    for (const selector of ['.side', '.side-item', '.hdr', '.tabbar', '.mobile-navigation', '.mobile-nav-selection', '.mobile-navigation [data-slot=tabs-trigger]', '.home-head']) {
      const a = shell.elements[selector], b = real.elements[selector];
      expect(a.length, selector).toBe(b.length);
      a.forEach((rect, i) => {for (const key of ['x', 'y', 'width', 'height'] as const) close(rect[key], b[i][key], `${selector} ${i} ${key}`);});
    }
    // The hero placeholder reserves the card's width and position; its height follows the duties.
    close(shell.elements['.hero'][0].x, real.elements['.hero'][0].x, 'hero x');
    close(shell.elements['.hero'][0].width, real.elements['.hero'][0].width, 'hero width');
    close(shell.elements['.hero'][0].y, real.elements['.hero'][0].y, 'hero y');
  });
}

test('pulse affects only placeholder content and is disabled by reduced motion', async ({page, openApp, backend}) => {
  let release!: () => void; backend.authGate = new Promise<void>(resolve => {release = resolve;});
  await openApp('admin', page, {waitForReady: false});
  try {
    await expect(page.locator('.startup-skeleton .skel').first()).toBeVisible();
    await page.emulateMedia({reducedMotion: 'no-preference'});
    const animations = await page.locator('.startup-skeleton').evaluate(el => el.getAnimations({subtree: true}).map(animation => ({name: (animation as CSSAnimation).animationName, placeholder: ((animation.effect as KeyframeEffect).target as Element).classList.contains('skel'), duration: animation.effect!.getTiming().duration, frames: (animation.effect as KeyframeEffect).getKeyframes()})));
    expect(animations.length).toBeGreaterThan(5);
    expect(animations.every(a => a.duration === 2000 && a.name === 'placeholder-pulse' && a.placeholder)).toBe(true);
    expect(animations.every(a => a.frames.every(frame => !('transform' in frame) && !('width' in frame) && !('height' in frame)))).toBe(true);
    const pulse = page.locator('.startup-skeleton .skel').first();
    const bounds = await pulse.boundingBox();
    const opacity = await pulse.evaluate(el => getComputedStyle(el).opacity);
    await page.waitForTimeout(500);
    expect(await pulse.evaluate(el => getComputedStyle(el).opacity)).not.toBe(opacity);
    expect(await pulse.boundingBox()).toEqual(bounds);
    await page.emulateMedia({reducedMotion: 'reduce'});
    expect(await page.locator('.startup-skeleton').evaluate(el => el.getAnimations({subtree: true}).length)).toBe(0);
  } finally {release();}
  await expect(page.locator('.startup-skeleton')).toHaveCount(0);
  expect(await page.evaluate(() => document.getAnimations().filter(a => (a as CSSAnimation).animationName === 'placeholder-pulse').length)).toBe(0);
});
