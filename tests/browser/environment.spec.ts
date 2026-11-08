import {test,expect,duty,openDutySheet} from './fixtures';
import {PROJECTS} from '../../lib/supabase/environment';
import {existsSync} from 'node:fs';
import type {Locator} from '@playwright/test';

/** Playwright attaches no candidate when a reference is missing; attach it so the visual review lists it for approval. */
async function shot(locator:Locator,name:string){
 if(!existsSync(test.info().snapshotPath(name))){
  const path=test.info().outputPath(name.replace(/\.png$/,'-actual.png'));
  await locator.screenshot({path,animations:'disabled',caret:'hide'});
  await test.info().attach(name.replace(/\.png$/,'-actual.png'),{path,contentType:'image/png'});
 }
 await expect.soft(locator).toHaveScreenshot(name);
}

for(const {name,url,origin,badge} of [
 {name:'localhost LOCAL',url:'http://127.0.0.1:48321',origin:'http://localhost:8787',badge:'LOCAL'},
 {name:'localhost DEV',url:PROJECTS.dev,origin:'http://localhost:8787',badge:'DEV'},
 {name:'deployed DEV',url:PROJECTS.dev,origin:'https://miko-dev.vercel.app',badge:'DEV'},
 {name:'localhost PROD',url:PROJECTS.prod,origin:'http://localhost:8787',badge:'PROD'},
 {name:'deployed PROD',url:PROJECTS.prod,origin:'https://miko-prod.vercel.app',badge:null},
]){
 test(`${name}: login and workspace indicator`,async({page,backend,openApp})=>{
  backend.url=url;backend.runtimeOrigin=origin;
  await openApp('signed-out');
  const indicator=page.locator('.environment-badge');
  if(badge)await expect(indicator).toHaveText(badge);else await expect(indicator).toHaveCount(0);
  await shot(page.locator('.access-card'),`${name.replaceAll(' ','-')}-login.png`);
  await openApp('admin');
  if(badge)await expect(indicator).toHaveText(badge);else await expect(indicator).toHaveCount(0);
  await shot(page.locator('.hdr'),`${name.replaceAll(' ','-')}-workspace.png`);
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth);
  expect(overflow).toBe(false);
  if(badge==='PROD'){
   // Production inspection is read-only in the app: nothing writes, every write control says so.
   await expect(page.getByRole('note').first()).toContainText('not database-enforced');
   await page.getByRole('tab',{name:'Schedule',exact:true}).click();
   await expect(page.locator('.month-primary')).toBeDisabled();
   await page.getByRole('button',{name:'Month actions',exact:true}).click();
   await expect(page.getByRole('menuitem',{name:'Constraints deadline'})).toHaveAttribute('aria-disabled','true');
   await page.keyboard.press('Escape');
   await expect(duty(page,'2026-11-02')).toBeDisabled();
   await page.getByRole('button',{name:'Settings'}).click();
   await expect(page.getByRole('textbox',{name:'Display name'})).toBeDisabled();
   await page.keyboard.press('Escape');
   await page.getByRole('tab',{name:'Team',exact:true}).click();
   await expect(page.getByRole('button',{name:'Approve',exact:true})).toBeDisabled();
   expect(backend.calls.filter(c=>!['duty_load','duty_balance','duty_notification_settings','duty_calendar_status'].includes(c.name))).toEqual([]);
  }
 });
}

test('local password form authenticates and opens the real workspace controller',async({page,backend,openApp})=>{
 backend.url='http://127.0.0.1:48321';backend.runtimeOrigin='http://localhost:8787';
 await openApp('signed-out');
 await expect(page.getByRole('button',{name:'Continue with Google'})).toHaveCount(0);
 await page.getByLabel('Password',{exact:true}).fill('synthetic-password');
 await page.getByRole('button',{name:'Sign in locally'}).click();
 await expect(page.getByRole('tab',{name:'Schedule',exact:true})).toBeVisible();
 await expect.poll(()=>backend.calls.map(c=>c.name).filter(n=>['duty_load','duty_generation_context'].includes(n))).toEqual(['duty_load','duty_generation_context']);
 // A signed-in admin can open a duty.
 await openDutySheet(page,'2026-11-02');
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
