import {test,expect,duty} from './fixtures';
import {PROJECTS} from '../../lib/supabase/environment';

for(const {name,url,origin,badge} of [
 {name:'localhost LOCAL',url:'http://127.0.0.1:58321',origin:'http://localhost:8787',badge:'LOCAL'},
 {name:'localhost DEV',url:PROJECTS.dev,origin:'http://localhost:8787',badge:'DEV'},
 {name:'deployed DEV',url:PROJECTS.dev,origin:'https://duty-scheduler-dev.vercel.app',badge:'DEV'},
 {name:'localhost PROD',url:PROJECTS.prod,origin:'http://localhost:8787',badge:'PROD'},
 {name:'deployed PROD',url:PROJECTS.prod,origin:'https://duty-scheduler-prod.vercel.app',badge:null},
]){
 test(`${name}: login and workspace indicator`,async({page,backend,openApp})=>{
  backend.url=url;backend.runtimeOrigin=origin;
  await openApp('signed-out');
  const indicator=page.locator('.environment-badge');
  if(badge)await expect(indicator).toHaveText(badge);else await expect(indicator).toHaveCount(0);
  await expect.soft(page.locator('.access-card')).toHaveScreenshot(`${name.replaceAll(' ','-')}-login.png`);
  await openApp('admin');
  if(badge)await expect(indicator).toHaveText(badge);else await expect(indicator).toHaveCount(0);
  await expect.soft(page.locator('.topbar')).toHaveScreenshot(`${name.replaceAll(' ','-')}-workspace.png`);
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth);
  expect(overflow).toBe(false);
  if(badge==='PROD'){
   expect(backend.calls.every(c=>c.name==='duty_load')).toBe(true);
   await expect(page.getByRole('note')).toContainText('not database-enforced');
   await expect(page.getByRole('button',{name:'Regenerate',exact:true})).toBeDisabled();
   const actions=page.getByRole('button',{name:'Month actions'});
   if(await actions.isVisible()){
    await actions.click();
    await expect(page.getByRole('menuitem',{name:'Change month deadline'})).toHaveAttribute('aria-disabled','true');
    await page.keyboard.press('Escape');
   }else await expect(page.getByRole('button',{name:'Change month deadline'})).toBeDisabled();
   await expect(duty(page,'2026-11-02')).toBeDisabled();
   await page.getByRole('button',{name:'My profile'}).click();
   await expect(page.getByRole('button',{name:'Save name'})).toBeDisabled();
   await page.keyboard.press('Escape');
   await page.getByRole('tab',{name:'Team & fairness'}).click();
   await expect(page.getByRole('button',{name:'Approve',exact:true})).toBeDisabled();
  }
 });
}

test('local password form authenticates and opens the real workspace controller',async({page,backend,openApp})=>{
 backend.url='http://127.0.0.1:58321';backend.runtimeOrigin='http://localhost:8787';
 await openApp('signed-out');
 await expect(page.getByRole('button',{name:'Continue with Google'})).toHaveCount(0);
 await page.getByLabel('Password',{exact:true}).fill('synthetic-password');
 await page.getByRole('button',{name:'Sign in locally'}).click();
 await expect(page.getByRole('tab',{name:'Schedule',exact:true})).toBeVisible();
 await expect.poll(()=>backend.calls.map(c=>c.name)).toEqual(['duty_load','duty_generation_context']);
});

test('unknown and mismatched project configuration cannot offer login or enter the workspace',async({page,openApp,backend})=>{
 await openApp('signed-out');
 for(const url of ['https://unknown.supabase.co','https://qhndiuahuxczujxxitsm.supabase.co/bad']){
  await page.route('**/api/config',route=>route.fulfill({json:{url,key:'sb_publishable_synthetic'}}));
  await page.reload();
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('Invalid connection configuration.');
  await expect(page.getByRole('button',{name:'Continue with Google'})).toBeDisabled();
  await expect(page.locator('.environment-badge')).toHaveCount(0);
  expect(backend.calls).toEqual([]);
 }
});
