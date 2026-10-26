import {test,expect,seed,MONTH,ids,NOW} from './fixtures';
import {monthNext} from '../../lib/rota/engine';
import {assertMonthNavigation,traverseMonths} from './month-navigation';
import {zoomContext,setBrowserZoom} from './zoom-context.mjs';

function navigationSnapshot(identity:'admin'|'a'='admin') {
  const initial=seed();
  initial.swapRequests=['approved','cancelled'].map((status,i)=>({
    id:`navigation-request-${i}`,month:MONTH,source_publication_id:initial.publications[0].id,
    requester_id:ids[identity],other_id:ids.b,from_day:'2026-11-02',from_end_day:'2026-11-03',
    to_day:'2026-11-03',to_end_day:'2026-11-04',explanation:'Synthetic completed request',
    status:status as 'approved'|'cancelled',accepted_by:null,accepted_at:null,created_at:NOW,
    resolved_at:NOW,resolved_by:ids.admin,result_publication_id:null,override_reason:'',
  }));
  // Four consecutive months span New Year; all remaining months have no row.
  // Keep the real controller's publication/version/permission rendering paths.
  for(let i=1;i<=3;i++) {
    const month=monthNext(MONTH,i),id=`20000000-0000-4000-8000-${String(20+i).padStart(12,'0')}`;
    initial.months.push({...initial.months[0],month,deadline:month+'-01',
      status:i===3?'published':'draft',current_publication_id:i===1?null:id});
    if(i>1)initial.publications.push({...initial.publications[0],id,month});
  }
  return initial;
}

for(const identity of ['admin','a'] as const) test(`month navigation survives empty, draft and published months for ${identity}`,async({page,backend,openApp})=>{
  test.setTimeout(120_000);
  backend.raw=navigationSnapshot(identity);
  await openApp(identity);
  await expect(page.locator('.swap-requests')).toBeVisible();
  for(const language of ['en','he']) {
    if(language==='he')await page.getByRole('button',{name:'Switch to Hebrew',exact:true}).click();
    await expect(page.locator('.app-shell')).toHaveAttribute('dir',language==='he'?'rtl':'ltr');
    for(let tab=0;tab<3;tab++) {
      await page.locator('[data-slot=tabs-trigger]').nth(tab).click();
      await traverseMonths(page);
    }
  }
  await page.reload();
  await expect(page.locator('.app-shell:not(.startup-skeleton)')).toBeVisible();
  await assertMonthNavigation(page);
  await traverseMonths(page,1);
  expect(backend.calls.every(call=>call.name==='duty_load'||(identity==='admin'&&call.name==='duty_generation_context')),'navigation only loads the workspace and manager allocation facts').toBe(true);
});

test('month navigation remains usable after actual browser zoom with visible completed requests',async({backend,openApp},info)=>{
  test.skip(info.project.name!=='desktop','One browser zoom matrix.');
  test.setTimeout(120_000);
  backend.raw=navigationSnapshot();
  const context=await zoomContext();
  try {
    const page=await context.newPage();await openApp('admin',page);
    for(const zoom of [1.25,1.5,2]) {
      expect(await setBrowserZoom(context,page,zoom)).toBe(zoom);
      await expect.poll(()=>page.evaluate(()=>devicePixelRatio)).toBe(zoom);
      for(const language of ['en','he']) {
        const toggle=page.getByRole('button',{name:language==='he'?'Switch to Hebrew':'Switch to English',exact:true});
        if(await toggle.count())await toggle.click();
        await expect(page.locator('.app-shell')).toHaveAttribute('dir',language==='he'?'rtl':'ltr');
        await traverseMonths(page);
      }
    }
  } finally {await context.close();}
  expect(backend.calls.every(call=>call.name==='duty_load'||call.name==='duty_generation_context')).toBe(true);
});
