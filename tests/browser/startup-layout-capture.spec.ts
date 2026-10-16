import {test,expect,ids,MONTH} from './fixtures';
import {publicCalendarCells} from '../../lib/rota/calendar-dates';
import {mkdirSync,writeFileSync} from 'node:fs';

for(const width of [320,375,390,430,768,1440])for(const lang of ['en','he'])for(const role of ['manager','engineer']) {
 test(`capture ${width} ${lang} ${role}`,async({page,openApp,backend},info)=>{
  test.skip(info.project.name!=='desktop');
  await page.setViewportSize({width,height:900});
  backend.url='http://127.0.0.1:54321';backend.runtimeOrigin='http://localhost:8787';
  if(role==='engineer')backend.raw.members.find(m=>m.id===ids.admin)!.role='engineer';
  await openApp('signed-out');
  if(lang==='he')await page.getByRole('button',{name:'\u05e2\u05d1\u05e8\u05d9\u05ea',exact:true}).click();
  let release!:()=>void;backend.authGate=new Promise<void>(resolve=>{release=resolve});
  await page.locator('input[type=password]').fill('synthetic-only');
  await page.locator('form.local-login button[type=submit]').click();
  const name=`after-${width}-${lang}-${role}`;
  mkdirSync('outputs/startup-layout',{recursive:true});
  const boxes=()=>page.evaluate(()=>Object.fromEntries(['.topbar','.top-actions','.month-toolbar','.month-title','.month-title>*','.toolbar-actions','.toolbar-actions>*','.nav-row','.nav-row [data-slot=tabs-trigger]','.calendar-panel','.calendar-top','.calendar-weekdays span','.calendar-grid>.day-cell,.skeleton-grid>.skeleton-day','.coverage-card','.fairness-card'].map(s=>[s,[...document.querySelectorAll(s)].map(el=>({date:el.getAttribute('data-date'),...el.getBoundingClientRect().toJSON()}))])));
  let before;
  try{
   await expect(page.locator('.startup-skeleton .day-cell')).toHaveCount(publicCalendarCells(MONTH).length);
   await expect(page.locator('.startup-skeleton')).not.toContainText(/Avery|Blair|Holiday|Synthetic vacation/);
   await expect(page.locator('.admin-avatar')).toHaveCount(0);
   before=await boxes();
   const screenshot=await page.screenshot({path:`outputs/startup-layout/${name}-shell.png`,fullPage:true});
   await info.attach('public-shell',{body:screenshot,contentType:'image/png'});
  }finally{release();}
  await expect(page.locator('.admin-avatar')).toBeVisible();
  await info.attach('private-calendar',{body:await page.screenshot({path:`outputs/startup-layout/${name}-real.png`,fullPage:true}),contentType:'image/png'});
  writeFileSync(`outputs/startup-layout/${name}.json`,JSON.stringify({shell:before,real:await boxes()},null,2));
 });
}
