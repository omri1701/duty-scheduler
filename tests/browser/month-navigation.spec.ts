import {test,expect,seed,MONTH,ids,NOW, switchLanguage} from './fixtures';
import type {Page} from '@playwright/test';
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
// Schedule, Availability and Team carry the month; Home does not (decision 2026-11-06).
const monthTabs=[1,2,3];
/** Completed requests moved from the calendar's list to the activity bell (decision 2026-11-06). */
async function expectCompletedRequests(page:Page) {
  await page.locator('[data-bell]').click();
  const list=page.locator('.bell-list');
  await expect(list).toContainText('Swap approved');
  await expect(list).toContainText('Swap cancelled');
  await page.keyboard.press('Escape');
  await expect(list).toBeHidden();
}
const allowed=(name:string,identity:'admin'|'a')=>['duty_load','duty_set_language','duty_notification_settings','duty_calendar_status','duty_balance'].includes(name)||(identity==='admin'&&name==='duty_generation_context');

for(const identity of ['admin','a'] as const) test(`month navigation survives empty, draft and published months for ${identity}`,async({page,backend,openApp})=>{
  test.setTimeout(120_000);
  backend.raw=navigationSnapshot(identity);
  await openApp(identity);
  await expectCompletedRequests(page);
  for(const language of ['en','he']) {
    if(language==='he')await switchLanguage(page, 'he');
    await expect(page.locator('.app-shell')).toHaveAttribute('dir',language==='he'?'rtl':'ltr');
    for(const tab of monthTabs) {
      await page.getByRole('tab').nth(tab).click();
      // One deep round trip; the other tab/language passes cover the seeded months, New Year and an empty month.
      await traverseMonths(page,language==='en'&&tab===1?24:4);
    }
  }
  await page.reload();
  await expect(page.locator('.app-shell:not(.startup-skeleton)')).toBeVisible();
  await page.getByRole('tab').nth(1).click();
  await assertMonthNavigation(page);
  await traverseMonths(page,1);
  expect(backend.calls.every(call=>allowed(call.name,identity)),'navigation only loads the workspace, the balance and manager allocation facts (and Settings reads and saves a language change)').toBe(true);
});

test('month navigation remains usable after actual browser zoom with visible completed requests',async({backend,openApp},info)=>{
  test.skip(info.project.name!=='desktop','One browser zoom matrix.');
  test.setTimeout(120_000);
  backend.raw=navigationSnapshot();
  const context=await zoomContext();
  try {
    const page=await context.newPage();await openApp('admin',page);
    await expectCompletedRequests(page);
    await page.getByRole('tab',{name:'Schedule',exact:true}).click();
    for(const zoom of [1.25,1.5,2]) {
      expect(await setBrowserZoom(context,page,zoom)).toBe(zoom);
      await expect.poll(()=>page.evaluate(()=>devicePixelRatio)).toBe(zoom);
      for(const language of ['en','he']) {
        await switchLanguage(page,language as 'en'|'he');
        await expect(page.locator('.app-shell')).toHaveAttribute('dir',language==='he'?'rtl':'ltr');
        await traverseMonths(page,zoom===2&&language==='en'?24:4);
      }
    }
  } finally {await context.close();}
  expect(backend.calls.every(call=>allowed(call.name,'admin'))).toBe(true);
});
