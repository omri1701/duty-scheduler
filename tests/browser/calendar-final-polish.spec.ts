import {test,expect,ids,duty,drag} from './fixtures';
import {webkit,devices} from '@playwright/test';

// Eligibility and date accents must use Israel even on an engineer's foreign browser.
test.use({timezoneId:'America/Los_Angeles'});

test('iPhone three draft actions share one comfortable row in both languages',async({openApp},info)=>{
  test.skip(info.project.name!=='desktop','One independent iPhone WebKit context.');
  const browser=await webkit.launch();
  try {
    const context=await browser.newContext({...devices['iPhone 13'],locale:'en-GB',timezoneId:'Asia/Jerusalem',reducedMotion:'reduce'});
    const page=await context.newPage();
    await openApp('admin',page);
    for(const lang of ['en','he']) {
      if(lang==='he')await page.getByRole('button',{name:'Switch to Hebrew',exact:true}).click();
      for(const width of [375,390,430]) {
        await page.setViewportSize({width,height:844});
        const buttons=page.locator('.reopened-actions>button:not(.month-actions-menu)');
        await expect(buttons).toHaveCount(3);
        const boxes=await buttons.evaluateAll(nodes=>nodes.map(node=>{
          const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,clipped:node.scrollWidth>node.clientWidth};
        }));
        for(const box of boxes) {
          expect(box.height).toBeGreaterThanOrEqual(44);
          expect(box.y).toBe(boxes[0].y);
          expect(Math.abs(box.width-boxes[0].width)).toBeLessThan(1);
          expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(width);
          expect(box.clipped).toBe(false);
        }
        const title=(await page.locator('.month-title').boundingBox())!,toolbar=(await page.locator('.month-toolbar').boundingBox())!;
        expect(Math.abs(title.x+title.width/2-toolbar.x-toolbar.width/2)).toBeLessThan(1);
        expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
        const path=info.outputPath(`iphone-actions-${width}-${lang}.png`);
        await page.screenshot({path,fullPage:true});
        await info.attach(`iphone-actions-${width}-${lang}`,{path,contentType:'image/png'});
      }
    }
  } finally {await browser.close()}
});

for(const role of ['admin','a'] as const)for(const method of ['tap','drag']) {
  test(`today published request ${role} ${method} after 09:00`,async({page,backend,openApp},info)=>{
    backend.raw.months[0].status='published';
    backend.raw.assignments.find(d=>d.publication_id&&d.day==='2026-11-02')!.primary_id=ids[role];
    await openApp(role);
    await page.clock.setFixedTime(new Date('2026-11-02T12:00:00Z'));
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await expect(page.locator('[aria-current="date"]')).toHaveText('2');
    await expect(duty(page,'2026-11-01')).toBeDisabled();
    await duty(page,'2026-11-03').click();
    await expect(duty(page,'2026-11-03')).toHaveAttribute('aria-pressed','false');
    if(method==='tap') {await duty(page,'2026-11-02').click();await duty(page,'2026-11-03').click();}
    else await drag(page,info.project.name==='mobile');
    await page.getByRole('button',{name:'Confirm Request',exact:true}).click();
    expect(backend.raw.swapRequests![0]).toMatchObject({requester_id:ids[role],from_day:'2026-11-02',to_day:'2026-11-03',status:'awaiting_engineer',accepted_by:null});
    expect(backend.calls.filter(c=>c.name==='duty_save_schedule')).toHaveLength(0);
  });
}

test('Israel midnight and resume refresh date accent and published eligibility',async({page,backend,openApp})=>{
  backend.raw.months[0].status='published';
  await openApp('a');
  await page.clock.install({time:new Date('2026-11-02T21:59:59Z')});
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(page.locator('[aria-current="date"]')).toHaveText('2');
  await expect(duty(page,'2026-11-02')).toBeEnabled();
  await page.clock.runFor(1100);
  await expect(page.locator('[aria-current="date"]')).toHaveText('3');
  await expect(duty(page,'2026-11-02')).toBeDisabled();
  await page.clock.setFixedTime(new Date('2026-11-07T12:00:00Z'));
  await page.evaluate(()=>window.dispatchEvent(new Event('pageshow')));
  await expect(duty(page,'2026-11-06').locator('[aria-current="date"]')).toHaveText('7');
  await expect(duty(page,'2026-11-06')).toBeDisabled();
  await expect(page.locator('[aria-current="date"]')).toHaveCount(1);
  await page.clock.setFixedTime(new Date('2026-11-08T12:00:00Z'));
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.locator('[aria-current="date"]')).toHaveText('8');
});
