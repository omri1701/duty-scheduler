import {test,expect,ids,duty,drag,keyboardRequest} from './fixtures';
import {blocks,ownerMonth} from '../../lib/rota/engine';
import {webkit,devices} from '@playwright/test';

test('iPhone WebKit keeps published requests and bilingual version controls usable',async({backend,openApp},info)=>{
  test.skip(info.project.name!=='desktop','One independent iPhone WebKit context.');
  backend.raw.months[0].status='published';
  backend.raw.assignments.find(d=>d.publication_id && d.day==='2026-11-02')!.primary_id=ids.admin;
  const browser=await webkit.launch();
  try {
    const context=await browser.newContext({...devices['iPhone 13'],locale:'en-GB',timezoneId:'Asia/Jerusalem',reducedMotion:'reduce'});
    const page=await context.newPage();
    await openApp('admin',page);
    await duty(page,'2026-11-02').tap(); await duty(page,'2026-11-03').tap();
    await expect(page.getByRole('button',{name:'Confirm Request',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'Cancel',exact:true}).click();
    await page.getByRole('button',{name:'Reopen draft',exact:true}).click();
    for(const lang of ['en','he']) {
      if(lang==='he')await page.getByRole('button',{name:'Switch to Hebrew',exact:true}).click();
      const controls=page.locator('.calendar-top');
      for(const button of await controls.getByRole('button').all()) {
        if(await button.isVisible())expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      }
      const title=(await page.locator('.month-title').boundingBox())!,toolbar=(await page.locator('.month-toolbar').boundingBox())!;
      expect(Math.abs(title.x+title.width/2-toolbar.x-toolbar.width/2)).toBeLessThan(1);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await page.getByRole('button',{name:lang==='en'?'Published':'פורסם',exact:true}).click();
      await expect(page.getByRole('button',{name:lang==='en'?'Special block':'מקטע מיוחד',exact:true})).toBeHidden();
      await info.attach(`iphone-${lang}`,{body:await page.screenshot({fullPage:true}),contentType:'image/png'});
    }
  } finally {await browser.close()}
});

test('engineer sees filters only with a publication and never sees drafts',async({page,backend,openApp})=>{
  backend.raw.months[0].current_publication_id=null;
  await openApp('a');
  await expect(page.getByRole('button',{name:'Whole team',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'My duties',exact:true})).toHaveCount(0);
  await expect(page.getByText('The manager has not published this month yet.')).toBeVisible();
  await expect(duty(page,'2026-11-02')).toContainText('Unassigned');
  await expect(duty(page,'2026-11-02')).toBeDisabled();
});

test('published manager requests from own duties by tap and drag, never directly edits',async({page,backend,openApp},info)=>{
  backend.raw.months[0].status='published';
  backend.raw.assignments.find(d=>d.publication_id && d.day==='2026-11-02')!.primary_id=ids.admin;
  await openApp();
  await expect(page.getByRole('button',{name:'Reopen draft',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Special block',exact:true})).toBeHidden();
  await expect(page.getByRole('button',{name:'Publish',exact:true})).toHaveCount(0);
  await expect(page.locator('.request-swap-hint,.month-title .status-badge')).toHaveCount(0);
  await duty(page,'2026-11-03').click();
  await expect(duty(page,'2026-11-03')).toHaveAttribute('aria-pressed','false');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await keyboardRequest(page);
  await expect(page.getByRole('button',{name:'Confirm Request',exact:true})).toBeVisible();
  await page.keyboard.press('Escape');
  await drag(page,info.project.name==='mobile');
  await page.getByRole('button',{name:'Confirm Request',exact:true}).click();
  expect(backend.raw.swapRequests![0]).toMatchObject({requester_id:ids.admin,status:'awaiting_engineer',accepted_by:null});
  expect(backend.calls.filter(c=>c.name==='duty_save_schedule')).toHaveLength(0);
});

test('reopened versions and My Duties are independent, Cancel Draft confirms and restores',async({page,backend,openApp})=>{
  backend.raw.months[0].status='published';
  const history=structuredClone(backend.raw.publications),live=backend.raw.months[0].current_publication_id;
  await openApp();
  await page.getByRole('button',{name:'Reopen draft',exact:true}).click();
  await expect(page.getByRole('button',{name:'Cancel draft',exact:true})).toBeVisible();
  backend.raw.assignments.find(d=>d.publication_id===null && d.day==='2026-11-02')!.primary_id=ids.admin;
  await page.reload();
  await expect(page.getByRole('button',{name:'Draft',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(duty(page,'2026-11-02')).toContainText('Avery');
  await page.getByRole('button',{name:'My duties',exact:true}).click();
  await page.getByRole('button',{name:'Published',exact:true}).click();
  await expect(page.getByRole('button',{name:'My duties',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(duty(page,'2026-11-02')).toContainText('Alex');
  await expect(duty(page,'2026-11-02')).toHaveClass(/faded/);
  await expect(page.getByRole('button',{name:'Special block',exact:true})).toBeHidden();
  await page.getByRole('button',{name:'Draft',exact:true}).click();
  await expect(duty(page,'2026-11-02')).not.toHaveClass(/faded/);
  await expect(page.getByRole('button',{name:'Special block',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Cancel draft',exact:true}).click();
  await expect(page.getByRole('button',{name:'Keep draft',exact:true})).toBeFocused();
  await page.getByRole('button',{name:'Keep draft',exact:true}).click();
  expect(backend.calls.filter(c=>c.name==='duty_cancel_draft')).toHaveLength(0);
  await page.getByRole('button',{name:'Cancel draft',exact:true}).click();
  backend.failNextSave=true;
  await page.getByRole('button',{name:'Discard draft',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Cancel draft?'})).toBeVisible();
  expect(backend.raw.months[0].status).toBe('draft');
  await page.getByRole('button',{name:'Discard draft',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Reopen draft',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Whole team',exact:true})).toBeVisible();
  expect(backend.raw.publications).toEqual(history);
  expect(backend.raw.months[0].current_publication_id).toBe(live);
  expect(backend.raw.assignments.filter(d=>d.publication_id===null)).toHaveLength(0);
  await page.getByRole('button',{name:'Reopen draft',exact:true}).click();
  await expect(page.getByRole('button',{name:'Draft',exact:true})).toHaveAttribute('aria-pressed','true');
  expect(backend.raw.assignments.find(d=>d.publication_id===null&&d.day==='2026-11-02')!.primary_id).toBe(ids.a);
  await page.getByRole('button',{name:'Published',exact:true}).click();
  await page.getByRole('button',{name:'Next month',exact:true}).click();
  await expect(page.getByRole('button',{name:'Generate month',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Draft',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Previous month',exact:true}).click();
  await expect(page.getByRole('button',{name:'Draft',exact:true})).toHaveAttribute('aria-pressed','true');
});

test('published manager drag uses the published split shape even when the draft is combined',async({page,backend,openApp},info)=>{
  backend.raw.months[0].status='published';
  const friday=backend.raw.assignments.find(d=>d.publication_id && d.day==='2026-11-06')!;
  friday.end_day='2026-11-07'; friday.points=.5;
  backend.raw.assignments.push({...friday,id:'published-saturday',day:'2026-11-07',end_day:'2026-11-08',primary_id:ids.admin});
  await openApp();
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
  for(let i=0;i<14;i++)await page.getByRole('button',{name:'Next month',exact:true}).click();
  if(lang==='he')await page.getByRole('button',{name:'Switch to Hebrew',exact:true}).click();
  const grid=page.locator('.calendar-grid');
  await expect(grid.locator('[data-date]').first()).toHaveAttribute('data-date','2028-01-02');
  const boundary=grid.locator(`[data-date="${split?'2028-01-01':'2027-12-31'}"]`);
  await expect(boundary).toHaveCount(0);
  await expect(grid.locator('[data-date="2027-12-31"],[data-date="2028-01-01"]')).toHaveCount(0);
  if(role==='admin') {
    await page.getByRole('button',{name:lang==='en'?'Published':'פורסם',exact:true}).click();
    await expect(boundary).toHaveCount(0);
  }
  await page.getByRole('button',{name:lang==='en'?'Previous month':'חודש קודם',exact:true}).click();
  if(split) {
    const saturday=grid.locator('[data-date="2028-01-01"]');
    await expect(saturday).toBeEnabled();
    await expect(saturday).not.toHaveClass(/outside|adjacent-duty/);
    await expect(saturday).toHaveAttribute('data-gesture-key','2028-01-01');
    await expect(saturday).toContainText(role==='admin'?'Blair':'Alex');
    if(role==='admin') {
      await saturday.click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.keyboard.press('Escape');
    }
    if(role==='admin' && lang==='en') {
      for(const [from,to] of [['2028-01-01','2027-12-30'],['2027-12-30','2028-01-01']]) {
        await drag(page,info.project.name==='mobile',from,to);
        await expect(page.getByRole('dialog')).toBeVisible();
        await page.keyboard.press('Escape');
      }
      const january=structuredClone(backend.raw.months.find(m=>m.month==='2028-01'));
      const independent=structuredClone(backend.raw.assignments.filter(d=>d.publication_id===null && d.day>='2028-01-02'));
      await page.getByRole('button',{name:'Special block',exact:true}).click();
      await page.getByLabel('First duty date',{exact:true}).fill('2027-12-31');
      await page.getByLabel('Last duty date',{exact:true}).fill('2028-01-01');
      await page.getByRole('button',{name:'Add special block',exact:true}).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(backend.raw.months.find(m=>m.month==='2028-01')).toEqual(january);
      expect(backend.raw.assignments.filter(d=>d.publication_id===null && d.day>='2028-01-02')).toEqual(independent);
    }
  }
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 });
}
