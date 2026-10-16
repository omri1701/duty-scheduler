import {test, expect} from './fixtures';

// Runs against next start by default, or the actual deployment via DUTY_E2E_URL.
// Only app assets reach that origin: configuration, auth and RPC use synthetic fixtures.
for (const width of [1440, 390, 320]) {
  test(`responsive CSS and delivered assets at ${width}px`, async ({page, openApp}, info) => {
    test.skip(info.project.name !== 'desktop', 'Run the viewport matrix once.');
    await page.setViewportSize({width, height: 900});
    const failedAssets: string[] = [];
    page.on('requestfailed', request => {
      if (['stylesheet', 'script'].includes(request.resourceType())) failedAssets.push(new URL(request.url()).pathname);
    });
    page.on('response', response => {
      if (['stylesheet', 'script'].includes(response.request().resourceType()) && !response.ok()) {
        failedAssets.push(`${response.status()} ${new URL(response.url()).pathname}`);
      }
    });
    await openApp();
    const stylesheets = await page.locator('link[rel="stylesheet"]').evaluateAll(links => links.map(link => {
      const sheet = (link as HTMLLinkElement).sheet;
      return {path: new URL((link as HTMLLinkElement).href).pathname, rules: sheet?.cssRules.length ?? 0};
    }));
    expect(stylesheets.length).toBeGreaterThan(0);
    for (const sheet of stylesheets) expect(sheet.rules, sheet.path).toBeGreaterThan(0);
    for (const language of ['en', 'he']) {
      if (language === 'he') await page.getByRole('button', {name: 'Switch to Hebrew'}).click();
      await expect(page.locator('html')).toHaveAttribute('dir', language === 'he' ? 'rtl' : 'ltr');
      const phone = width <= 600;
      const nav = page.locator('.nav-row');
      await expect(nav).toBeVisible();
      await expect(nav).toHaveCSS('position', phone ? 'fixed' : 'static');
      await expect(page.locator('.mobile-navigation')).toHaveCount(phone ? 1 : 0);
      await expect(nav.getByRole('tab')).toHaveCount(3);
      if (phone) {
        await expect(page.locator('.mobile-navigation')).toBeVisible();
        const box = (await nav.boundingBox())!;
        expect(Math.abs(box.y + box.height - 900)).toBeLessThan(1);
      } else {
        await expect(nav.locator(':scope > [role="tablist"]')).toBeVisible();
      }
      for (const [tab, grid] of [[0, '.calendar-grid'], [1, '.availability-grid']] as const) {
        await nav.getByRole('tab').nth(tab).click();
        const geometry = await page.locator(grid).evaluate(el => {
          const css = getComputedStyle(el), box = el.getBoundingClientRect();
          return {display: css.display, columns: css.gridTemplateColumns.split(' ').map(Number.parseFloat),
            left: box.left, right: box.right, overflow: document.documentElement.scrollWidth > innerWidth};
        });
        expect(geometry.display).toBe('grid');
        expect(geometry.columns).toHaveLength(7);
        expect(Math.max(...geometry.columns) - Math.min(...geometry.columns)).toBeLessThan(1);
        expect(geometry.left).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(width);
        expect(geometry.overflow).toBe(false);
        if (tab === 1) {
          await expect(page.locator('.mobile-availability-legend')).toHaveCSS('display', phone ? 'flex' : 'none');
          await expect(page.locator('.mobile-availability-weekdays')).toHaveCSS('display', phone ? 'grid' : 'none');
          await expect(page.locator('.availability-day:not(.outside) .availability-weekday').first()).toHaveCSS('display', phone ? 'none' : 'block');
        }
        await page.screenshot({path: info.outputPath(`${language}-${tab === 0 ? 'schedule' : 'availability'}.png`), fullPage: true});
      }
      await nav.getByRole('tab').first().click();
    }
    expect(failedAssets, 'critical CSS/JS downloads').toEqual([]);
    await info.attach('stylesheets', {body: JSON.stringify(stylesheets), contentType: 'application/json'});
  });
}
