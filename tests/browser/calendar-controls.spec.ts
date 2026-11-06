import {test,expect,ids,duty,drag,targetReady,switchLanguage,monthAction} from './fixtures';
import {blocks,ownerMonth} from '../../lib/rota/engine';
import {webkit,devices,type Page} from '@playwright/test';

const schedule=(page:Page,lang='en')=>page.getByRole('tab',{name:lang==='en'?'Schedule':'לוח',exact:true}).click();
/** A tap (or Enter) opens the duty sheet on PC; on phones it shows the day's details, whose row opens the sheet. */
async function openSheet(page:Page,day:string,how:'click'|'tap'|'Enter'='click') {
  if(how==='Enter'){await duty(page,day).focus();await page.keyboard.press('Enter');} else await duty(page,day)[how]();
  const sheet=page.getByRole('dialog'),details=page.locator('[data-day-details] .day-duty');
  await expect(sheet.or(details).first()).toBeVisible();
  if(!(await sheet.isVisible())) {if(how==='Enter'){await details.focus();await page.keyboard.press('Enter');} else await details[how]();}
  await expect(sheet).toBeVisible();
}
async function menuItems(page:Page) {
  await page.getByRole('button',{name:/^(Month actions|פעולות לחודש)$/}).click();
  const items=await page.getByRole('menuitem').allTextContents();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  return items;
}

test('iPhone WebKit keeps published requests and bilingual version controls usable',async({backend,openApp},info)=>{
  test.skip(info.project.name!=='desktop','One independent iPhone WebKit context.');
  backend.raw.months[0].status='published';
  backend.raw.assignments.find(d=>d.publication_id && d.day==='2026-11-02')!.primary_id=ids.admin;
  const browser=await webkit.launch();
  try {
    const context=await browser.newContext({...devices['iPhone 13'],locale:'en-GB',timezoneId:'Asia/Jerusalem',reducedMotion:'reduce'});
    const page=await context.newPage();
    await openApp('admin',page);
    await schedule(page);
    // A tap shows the day; its row opens the duty sheet, whose Swap starts a request from the admin's own duty.
    await openSheet(page,'2026-11-02','tap');
    await page.getByRole('dialog').getByRole('button',{name:'Swap',exact:true}).tap();
    await targetReady(page,'2026-11-03');
    await duty(page,'2026-11-03').tap();
    await expect(page.getByRole('button',{name:'Confirm Request',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'Cancel',exact:true}).click();
    await page.getByRole('button',{name:'Reopen',exact:true}).click();
    await expect(page.getByRole('radio',{name:'Draft',exact:true})).toBeChecked();
    for(const lang of ['en','he']) {
      if(lang==='he')await switchLanguage(page, 'he');
      await page.getByRole('radio',{name:lang==='en'?'Draft':'טיוטה',exact:true}).click();
      // One primary action and the ⋯ menu, touch-sized, nothing clipped, the title centred.
      const bar=page.locator('.month-bar'),box=(await bar.boundingBox())!;
      await expect(bar.locator('.month-primary')).toHaveCount(1);
      await expect(bar.getByRole('button',{name:lang==='en'?'Month actions':'פעולות לחודש',exact:true})).toBeVisible();
      for(const button of await bar.getByRole('button').all()) {
        if(!await button.isVisible())continue;
        const b=(await button.boundingBox())!;
        expect(b.height).toBeGreaterThanOrEqual(44);
        expect(b.x).toBeGreaterThanOrEqual(box.x-1);
        expect(b.x+b.width).toBeLessThanOrEqual(box.x+box.width+1);
      }
      const title=(await bar.locator('.month-title h2').boundingBox())!;
      expect(Math.abs(title.x+title.width/2-box.x-box.width/2)).toBeLessThan(1);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await page.getByRole('radio',{name:lang==='en'?'Published':'פורסם',exact:true}).click();
      expect(await menuItems(page)).not.toContain(lang==='en'?'Special block':'מקטע מיוחד');
      await info.attach(`iphone-${lang}`,{body:await page.screenshot({fullPage:true}),contentType:'image/png'});
    }
  } finally {await browser.close()}
});

test('engineer sees an unpublished month as not published and never sees drafts',async({page,backend,openApp})=>{
  backend.raw.months[0].current_publication_id=null;
  await openApp('a');
  await schedule(page);
  await expect(page.locator('.month-bar .month-status')).toHaveText('Not published yet');
  await expect(duty(page,'2026-11-02')).toHaveAccessibleName(/Unassigned/);
  await expect(duty(page,'2026-11-02')).not.toContainText('Alex');
  // The day still opens; its sheet says why nothing can be done yet.
  await openSheet(page,'2026-11-02');
  const sheet=page.getByRole('dialog');
  await expect(sheet).toContainText('Unassigned');
  await expect(sheet).toContainText('Not published yet');
  await expect(sheet.getByRole('button',{name:'Swap',exact:true})).toBeDisabled();
  await expect(sheet.getByRole('button',{name:'Edit',exact:true})).toHaveCount(0);
});

test('published manager taps to edit, swaps from the editor or by drag',async({page,backend,openApp},info)=>{
  backend.raw.months[0].status='published';
  backend.raw.assignments.find(d=>d.publication_id && d.day==='2026-11-02')!.primary_id=ids.admin;
  await openApp();
  await schedule(page);
  await expect(page.getByRole('button',{name:'Reopen',exact:true})).toBeVisible();
  expect(await menuItems(page)).not.toContain('Special block');
  await expect(page.getByRole('button',{name:'Publish',exact:true})).toHaveCount(0);
  await expect(page.locator('.request-swap-hint')).toHaveCount(0);
  // A tap on any member's duty opens its sheet and Edit opens Edit duty; "Swap with another duty"
  // selects it for the next tap, and a second tap on the same duty cancels the selection.
  await openSheet(page,'2026-11-03');
  await page.getByRole('dialog').getByRole('button',{name:'Edit',exact:true}).click();
  await page.getByRole('dialog',{name:'Edit duty'}).getByRole('button',{name:'Swap with another duty…',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(duty(page,'2026-11-03')).toHaveAttribute('aria-pressed','true');
  await duty(page,'2026-11-03').click();
  await expect(duty(page,'2026-11-03')).toHaveAttribute('aria-pressed','false');
  await openSheet(page,'2026-11-03');
  await page.getByRole('dialog').getByRole('button',{name:'Edit',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Edit duty'})).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // Keyboard: Enter opens the sheet; its editor starts the swap and the next key picks the second duty.
  await openSheet(page,'2026-11-02','Enter');
  await page.getByRole('dialog').getByRole('button',{name:'Edit',exact:true}).click();
  await page.getByRole('button',{name:'Swap with another duty…',exact:true}).click();
  await expect(duty(page,'2026-11-02')).toHaveAttribute('aria-pressed','true');
  await targetReady(page,'2026-11-03'); await duty(page,'2026-11-03').focus(); await page.keyboard.press('Space');
  await expect(page.getByRole('button',{name:'Confirm Request',exact:true})).toBeVisible();
  await page.keyboard.press('Escape');
  await drag(page,info.project.name==='mobile');
  await page.getByRole('button',{name:'Confirm Request',exact:true}).click();
  expect(backend.raw.swapRequests![0]).toMatchObject({requester_id:ids.admin,status:'awaiting_engineer',accepted_by:null});
  expect(backend.calls.filter(c=>c.name==='duty_save_schedule')).toHaveLength(0);
});

test('reopened versions are independent, Cancel Draft confirms and restores',async({page,backend,openApp})=>{
  backend.raw.months[0].status='published';
  const history=structuredClone(backend.raw.publications),live=backend.raw.months[0].current_publication_id;
  await openApp();
  await schedule(page);
  await page.getByRole('button',{name:'Reopen',exact:true}).click();
  expect(await menuItems(page)).toContain('Cancel draft');
  backend.raw.assignments.find(d=>d.publication_id===null && d.day==='2026-11-02')!.primary_id=ids.admin;
  await page.reload();
  await schedule(page);
  await expect(page.getByRole('radio',{name:'Draft',exact:true})).toBeChecked();
  // 1 and 2 November are both Avery's now, so the name shows once on the streak; the accessible name stays per duty.
  await expect(duty(page,'2026-11-02')).toHaveAccessibleName(/Avery/);
  await expect(duty(page,'2026-11-02')).toHaveClass(/\bmine\b/);
  await page.getByRole('radio',{name:'Published',exact:true}).click();
  await expect(duty(page,'2026-11-02')).toContainText('Alex');
  await expect(duty(page,'2026-11-02')).not.toHaveClass(/\bmine\b/);
  expect(await menuItems(page)).not.toContain('Special block');
  await page.getByRole('radio',{name:'Draft',exact:true}).click();
  await expect(duty(page,'2026-11-02')).toHaveClass(/\bmine\b/);
  expect(await menuItems(page)).toContain('Special block');
  await monthAction(page,'Cancel draft');
  await expect(page.getByRole('button',{name:'Keep draft',exact:true})).toBeFocused();
  await page.getByRole('button',{name:'Keep draft',exact:true}).click();
  expect(backend.calls.filter(c=>c.name==='duty_cancel_draft')).toHaveLength(0);
  await monthAction(page,'Cancel draft');
  backend.failNextSave=true;
  await page.getByRole('button',{name:'Discard draft',exact:true}).click();
  await expect(page.getByRole('alertdialog',{name:'Cancel draft?'})).toBeVisible();
  expect(backend.raw.months[0].status).toBe('draft');
  await page.getByRole('button',{name:'Discard draft',exact:true}).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Reopen',exact:true})).toBeVisible();
  await expect(page.getByRole('radio',{name:'Draft',exact:true})).toHaveCount(0);
  expect(backend.raw.publications).toEqual(history);
  expect(backend.raw.months[0].current_publication_id).toBe(live);
  expect(backend.raw.assignments.filter(d=>d.publication_id===null)).toHaveLength(0);
  await page.getByRole('button',{name:'Reopen',exact:true}).click();
  await expect(page.getByRole('radio',{name:'Draft',exact:true})).toBeChecked();
  expect(backend.raw.assignments.find(d=>d.publication_id===null&&d.day==='2026-11-02')!.primary_id).toBe(ids.a);
  await page.getByRole('radio',{name:'Published',exact:true}).click();
  await page.getByRole('button',{name:'Next month',exact:true}).click();
  await expect(page.getByRole('button',{name:'Plan the month',exact:true})).toBeVisible();
  await expect(page.getByRole('radio',{name:'Draft',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Previous month',exact:true}).click();
  await expect(page.getByRole('radio',{name:'Draft',exact:true})).toBeChecked();
});

test('published manager drag uses the published split shape even when the draft is combined',async({page,backend,openApp},info)=>{
  backend.raw.months[0].status='published';
  const friday=backend.raw.assignments.find(d=>d.publication_id && d.day==='2026-11-06')!;
  friday.end_day='2026-11-07'; friday.points=.5;
  backend.raw.assignments.push({...friday,id:'published-saturday',day:'2026-11-07',end_day:'2026-11-08',primary_id:ids.admin});
  await openApp();
  await schedule(page);
  await expect(duty(page,'2026-11-07')).toContainText('Avery');
  await drag(page,info.project.name==='mobile','2026-11-07','2026-11-03');
  await page.getByRole('button',{name:'Confirm Request',exact:true}).click();
  expect(backend.raw.swapRequests![0]).toMatchObject({from_day:'2026-11-07',from_end_day:'2026-11-08',requester_id:ids.admin,status:'awaiting_engineer'});
});

for(const split of [false,true])for(const role of ['admin','a'] as const)for(const lang of ['en','he']) {
 test(`December owns the cross-year weekend and January omits it ${split?'split':'combined'} ${role} ${lang}`,async({page,backend,openApp},info)=>{
  if(role==='admin' && split && lang==='en')backend.runtimeOrigin='http://localhost:8787';
  backend.raw.assignments=[];backend.raw.publications=[];backend.raw.months=[];
  for(const month of ['2027-12','2028-01']) {
    const publication=`published-${month}`;
    backend.raw.months.push({month,deadline:month+'-01',status:'draft',generated:true,current_publication_id:publication,publication_sequence:1});
    backend.raw.publications.push({id:publication,month,version:1,published_at:'2026-10-01T00:00:00Z',published_by:ids.admin});
    for(const b of blocks(month,[],split?['2027-12-31']:[]).filter(b=>ownerMonth(b)===month)) {
      const row={day:b.start,end_day:b.end,secondary_id:null,manager_override:false,title:'',extra_points:0,points:b.points};
      backend.raw.assignments.push({...row,id:`${month}-${b.id}`,publication_id:publication,primary_id:ids.a},
        {...row,id:`draft-${b.id}`,publication_id:null,primary_id:b.id==='2027-12-30'?ids.c:ids.b});
    }
  }
  await openApp(role);
  await schedule(page);
  for(let i=0;i<14;i++)await page.getByRole('button',{name:'Next month',exact:true}).click();
  if(lang==='he')await switchLanguage(page, 'he');
  const grid=page.locator('.calendar-grid');
  await expect(grid.locator('[data-date]').first()).toHaveAttribute('data-date','2028-01-02');
  const boundary=grid.locator(`[data-date="${split?'2028-01-01':'2027-12-31'}"]`);
  await expect(boundary).toHaveCount(0);
  await expect(grid.locator('[data-date="2027-12-31"],[data-date="2028-01-01"]')).toHaveCount(0);
  if(role==='admin') {
    await page.getByRole('radio',{name:lang==='en'?'Published':'פורסם',exact:true}).click();
    await expect(boundary).toHaveCount(0);
  }
  await page.getByRole('button',{name:lang==='en'?'Previous month':'חודש קודם',exact:true}).click();
  if(split) {
    const saturday=grid.locator('[data-date="2028-01-01"]');
    await expect(saturday).toBeEnabled();
    await expect(saturday).not.toHaveClass(/outside|adjacent-duty/);
    await expect(saturday).toHaveAttribute('data-gesture-key','2028-01-01');
    // Both halves belong to one member: the bar names them once, each half keeps its accessible name.
    await expect(saturday).toHaveAccessibleName(role==='admin'?/Blair/:/Alex/);
    if(role==='admin') {
      await openSheet(page,'2028-01-01');
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
    }
    if(role==='admin' && lang==='en') {
      for(const [from,to] of [['2028-01-01','2027-12-30'],['2027-12-30','2028-01-01']]) {
        await drag(page,info.project.name==='mobile',from,to);
        await expect(page.getByRole('dialog')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).toHaveCount(0);
      }
      const january=structuredClone(backend.raw.months.find(m=>m.month==='2028-01'));
      const independent=structuredClone(backend.raw.assignments.filter(d=>d.publication_id===null && d.day>='2028-01-02'));
      await monthAction(page,'Special block');
      await page.getByLabel('First day',{exact:true}).fill('2027-12-31');
      await page.getByLabel('Last day',{exact:true}).fill('2028-01-01');
      await page.getByRole('button',{name:'Add special block',exact:true}).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(backend.raw.months.find(m=>m.month==='2028-01')).toEqual(january);
      expect(backend.raw.assignments.filter(d=>d.publication_id===null && d.day>='2028-01-02')).toEqual(independent);
    }
  }
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 });
}
