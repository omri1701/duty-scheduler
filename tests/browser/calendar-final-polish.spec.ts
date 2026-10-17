import {test,expect,ids,duty,drag,seed} from './fixtures';
import {webkit,devices} from '@playwright/test';

// Eligibility and date accents must use Israel even on an engineer's foreign browser.
test.use({timezoneId:'America/Los_Angeles'});

const managerStates=['reopened','published','new','generated'] as const;
function managerMonth(state:typeof managerStates[number]) {
  const raw=seed();
  if(state==='published')raw.months[0].status='published';
  if(state==='new'||state==='generated') {
    raw.months[0].current_publication_id=null;raw.months[0].publication_sequence=0;
    raw.months[0].generated=state==='generated';raw.publications=[];
    raw.assignments=state==='new'?[]:raw.assignments.filter(d=>d.publication_id===null);
  }
  return raw;
}

test('iPhone all manager states keep menu and workflow actions on one row',async({backend,openApp},info)=>{
  test.skip(info.project.name!=='desktop','One independent iPhone WebKit context.');
  const browser=await webkit.launch();
  try {
    const context=await browser.newContext({...devices['iPhone 13'],locale:'en-GB',timezoneId:'Asia/Jerusalem',reducedMotion:'reduce'});
    for(const state of managerStates) {
    backend.raw=managerMonth(state);
    const page=await context.newPage();await openApp('admin',page);
    for(const lang of ['en','he']) {
      if(lang==='he')await page.getByRole('button',{name:'Switch to Hebrew',exact:true}).click();
      for(const width of [375,390,430]) {
        await page.setViewportSize({width,height:844});
        const buttons=page.locator('.toolbar-actions').getByRole('button');
        await expect(buttons).toHaveCount(state==='reopened'?4:state==='published'?2:3);
        const boxes=await buttons.evaluateAll(nodes=>nodes.map(node=>{
          const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,clipped:node.scrollWidth>node.clientWidth};
        }));
        for(const box of boxes) {
          expect(box.height).toBeGreaterThanOrEqual(44);
          expect(box.y).toBe(boxes[0].y);
          expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(width);
          expect(box.clipped).toBe(false);
        }
        expect(boxes[0].width).toBe(44);
        for(const box of boxes.slice(1))expect(Math.abs(box.width-boxes[1].width)).toBeLessThan(1);
        expect(lang==='en'?boxes[1].x-(boxes[0].x+44):boxes[0].x-(boxes[1].x+boxes[1].width)).toBeGreaterThanOrEqual(12);
        const title=(await page.locator('.month-title').boundingBox())!,toolbar=(await page.locator('.month-toolbar').boundingBox())!;
        expect(Math.abs(title.x+title.width/2-toolbar.x-toolbar.width/2)).toBeLessThan(1);
        expect(title.y+title.height).toBeLessThanOrEqual(boxes[0].y);
        expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
        if(state==='new')await expect(page.getByRole('button',{name:lang==='en'?'Generate month':'יצירת שיבוץ',exact:true})).toBeVisible();
        const path=info.outputPath(`iphone-${state}-${width}-${lang}.png`);
        await page.screenshot({path,fullPage:true});
        await info.attach(`iphone-${state}-${width}-${lang}`,{path,contentType:'image/png'});
        if(width===375) {
          const menu=buttons.first();await menu.focus();await page.keyboard.press('Enter');
          await expect(page.getByRole('menuitem',{name:lang==='en'?'Versions':'גרסאות',exact:true})).toBeFocused();
          await page.keyboard.press('Escape');await expect(menu).toBeFocused();
        }
      }
    }
    await page.close();
    }
  } finally {await browser.close()}
});

test('desktop direct tools frame a centered month in all manager states',async({page,backend,openApp},info)=>{
  test.skip(info.project.name!=='desktop','Desktop responsive matrix runs once.');
  for(const state of managerStates) {
    backend.raw=managerMonth(state);await openApp();
    for(const lang of ['en','he']) {
      if(lang==='he')await page.getByRole('button',{name:'Switch to Hebrew',exact:true}).click();
      for(const width of [1024,1280,1440]) {
        await page.setViewportSize({width,height:1000});
        await expect(page.getByRole('button',{name:lang==='en'?'Month actions':'פעולות לחודש',exact:true})).toHaveCount(0);
        const regions=await page.locator('.desktop-month-tools,.month-title,.toolbar-actions').evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}}));
        const toolbar=(await page.locator('.month-toolbar').boundingBox())!;
        expect(Math.abs(regions[1].x+regions[1].width/2-toolbar.x-toolbar.width/2)).toBeLessThan(1);
        const ordered=[...regions].sort((a,b)=>a.x-b.x);
        expect(ordered[0].x+ordered[0].width).toBeLessThanOrEqual(ordered[1].x);
        expect(ordered[1].x+ordered[1].width).toBeLessThanOrEqual(ordered[2].x);
        expect(lang==='en'?regions[0].x<regions[2].x:regions[0].x>regions[2].x).toBe(true);
        const clipped=await page.locator('.desktop-month-tools,.workflow-actions,.month-toolbar button').evaluateAll(nodes=>nodes.filter(n=>n.getClientRects().length).some(n=>n.scrollWidth>n.clientWidth));
        expect(clipped).toBe(false);
        if(width===1440) {
          const path=info.outputPath(`desktop-${state}-${lang}.png`);await page.screenshot({path,fullPage:true});await info.attach(`desktop-${state}-${lang}`,{path,contentType:'image/png'});
        }
      }
      for(const name of [lang==='en'?'Versions':'גרסאות',lang==='en'?'Change month deadline':'שינוי מועד אחרון לחודש']) {
        const button=page.getByRole('button',{name,exact:true});await button.focus();await page.keyboard.press('Enter');
        await expect(page.getByRole('dialog')).toBeVisible();await page.keyboard.press('Escape');await expect(button).toBeFocused();
      }
    }
  }
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
