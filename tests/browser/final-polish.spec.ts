import {test,expect,ids,duty,touchEvent,NOW} from './fixtures';
import type {Page} from '@playwright/test';

test('native select cloning loses the live role selection',async({page})=>{
 const result=await page.evaluate(()=>{
  const select=document.createElement('select');
  select.add(new Option('Admin','admin'));select.add(new Option('Engineer','engineer'));
  select.value='engineer';
  const clone=select.cloneNode(true) as HTMLSelectElement;
  return{source:select.value,clone:clone.value};
 });
 expect(result).toEqual({source:'engineer',clone:'admin'});
});

for(const lang of ['en','he'] as const)test(`drag preview preserves admin, engineer and inactive row in ${lang}`,async({page,openApp,backend},info)=>{
 backend.raw.members.find(m=>m.id===ids.e)!.active=false;
 const original=structuredClone(backend.raw.members);
 await page.setViewportSize({width:info.project.name==='mobile'?390:1440,height:1200});
 await page.emulateMedia({reducedMotion:'no-preference'});await openApp();
 if(lang==='he')await page.getByRole('button',{name:'Switch to Hebrew'}).click();
 await page.getByRole('tab').nth(2).click();
 for(const id of [ids.admin,ids.a,ids.e]){
  const row=page.locator(`.gesture-grid [data-gesture-key="${id}"]`),handle=row.locator('.team-grip');
  const expected=await row.evaluate(el=>({
   role:(el.querySelector('select') as HTMLSelectElement).selectedOptions[0].textContent,
   name:el.querySelector('.team-name')!.textContent,
   points:[...el.querySelectorAll('.team-points')].map(e=>e.textContent),
   avatar:el.querySelector('.avatar')!.getAttribute('style'),
   rank:el.querySelector('.team-grip span')!.textContent,
   active:el.querySelector('.active-checkbox [role=checkbox]')!.getAttribute('data-state'),
  }));
  // Admin rows carry the No weekends toggle: on a phone the last row can start below the fold.
  await handle.scrollIntoViewIfNeeded();
  const a=(await handle.boundingBox())!,x=a.x+a.width/2,y=a.y+a.height/2,mobile=info.project.name==='mobile';
  if(mobile){await touchEvent(page,'touchstart',x,y);await page.waitForTimeout(400)}
  else{await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x,y+7)}
  const ghost=page.locator('.mobile-drag-preview');await expect(ghost).toBeVisible();
  await expect(ghost.locator('select,input,textarea')).toHaveCount(0);
  expect(await ghost.evaluate(el=>(el as HTMLElement).inert)).toBe(true);
  await expect(ghost).toHaveAttribute('aria-hidden','true');
  expect(await ghost.evaluate(el=>Number(getComputedStyle(el).opacity))).toBe(id === ids.e ? .45 : 1);
  const roleAlignment=await ghost.locator('.drag-control-value').evaluate(el=>{
   const range=document.createRange();range.selectNodeContents(el);
   const text=range.getBoundingClientRect(),box=el.getBoundingClientRect();
   return Math.abs(text.y+text.height/2-(box.y+box.height/2));
  });
  expect(roleAlignment).toBeLessThanOrEqual(2);
  for(const offset of [15,-15,30]){
   if(mobile)await touchEvent(page,'touchmove',x,y+offset);else await page.mouse.move(x,y+offset);
   const actual=await ghost.evaluate(el=>({
    role:el.querySelector('.team-role .drag-control-value')!.textContent,
    name:el.querySelector('.team-name')!.textContent,
    points:[...el.querySelectorAll('.team-points')].map(e=>e.textContent),
    avatar:el.querySelector('.avatar')!.getAttribute('style'),
    rank:el.querySelector('.team-grip span')!.textContent,
    active:el.querySelector('.active-checkbox [role=checkbox]')!.getAttribute('data-state'),
   }));
   expect(actual).toEqual(expected);
  }
  await page.screenshot({path:info.outputPath(`preview-${id}.png`)});
  // Observe every animation frame through release; no transient first-option label.
  const frames=ghost.evaluate(async el=>{
   const labels=[];
   while(el.isConnected){labels.push(el.querySelector('.team-role .drag-control-value')!.textContent);await new Promise<void>(r=>requestAnimationFrame(()=>r()))}
   return labels;
  });
  if(mobile)await touchEvent(page,'touchend',x,y+30);else await page.mouse.up();
  expect((await frames).every(label=>label===expected.role)).toBe(true);
  await expect(row.locator('select')).toHaveValue(id===ids.admin?'admin':'engineer');
  expect(backend.raw.members).toEqual(original);
  await page.clock.setFixedTime(new Date(Date.parse(NOW)+1000));
 }
 expect(backend.calls.filter(c=>c.name==='duty_save_schedule')).toHaveLength(0);
});

async function propose(page:Page,mobile:boolean){
 const from=duty(page,'2026-11-02'),to=duty(page,'2026-11-06');
 await from.scrollIntoViewIfNeeded();
 const a=(await from.boundingBox())!,b=(await to.boundingBox())!;
 const x=a.x+a.width/2,y=a.y+a.height/2,tx=b.x+b.width/2,ty=b.y+b.height/2;
 if(mobile){await touchEvent(page,'touchstart',x,y);await page.waitForTimeout(400);await touchEvent(page,'touchmove',tx,ty);await touchEvent(page,'touchend',tx,ty)}
 else{await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(tx,ty,{steps:8});await page.mouse.up()}
 await expect(page.getByRole('dialog')).toBeVisible();
}

for(const lang of ['en','he'] as const)for(const availability of [false,true])test(`weekend swap consent, square checkbox and persistence ${lang}, availability=${availability}`,async({page,openApp,backend},info)=>{
 for(const row of backend.raw.assignments.filter(d=>d.publication_id===null)){
  row.primary_id=row.day==='2026-11-02'||row.day==='2026-11-13'?ids.a:ids.b;
 }
 if(availability)backend.raw.constraints.push({member_id:ids.a,day:'2026-11-07',kind:'no',note:'Weekend vacation'});
 const published=structuredClone(backend.raw.assignments.filter(d=>d.publication_id!==null));
 await openApp();if(lang==='he')await page.getByRole('button',{name:'Switch to Hebrew'}).click();
 const mobile=info.project.name==='mobile',dialog=page.getByRole('dialog'),confirm=dialog.locator('button').filter({hasText:lang==='en'?'Confirm swap':'אישור החלפה'});
 await propose(page,mobile);
 await expect(dialog).toContainText(lang==='en'?'Alex Atlas 2 weekends in November':'Alex Atlas 2 סופי שבוע בחודש נובמבר');
 if(availability){await expect(dialog).toContainText('Weekend vacation');await expect(dialog).toContainText(lang==='en'?'Availability conflicts':'התנגשות עם אילוצים')}
 const label=dialog.locator('.manager-override'),checkbox=label.getByRole('checkbox');
 await expect(confirm).toBeDisabled();await expect(checkbox).not.toBeChecked();
 await label.evaluate(el=>{el.style.maxWidth='145px'});
 const box=(await checkbox.boundingBox())!,labelBox=(await label.boundingBox())!;
 expect(box.width).toBe(24);expect(box.height).toBe(24);expect(labelBox.height).toBeGreaterThan(44);
 expect(box.y-labelBox.y).toBe(10);
 expect(lang==='he'?box.x>labelBox.x+labelBox.width/2:box.x<labelBox.x+labelBox.width/2).toBe(true);
 await page.keyboard.press('Tab');await checkbox.focus();expect(await checkbox.evaluate(el=>getComputedStyle(el).outlineStyle)).toBe('solid');
 await page.keyboard.press('Space');await expect(confirm).toBeEnabled();
 const check=(await checkbox.locator('svg').boundingBox())!;
 expect(check.x+check.width/2).toBeCloseTo(box.x+12,0);expect(check.y+check.height/2).toBeCloseTo(box.y+12,0);
 await page.screenshot({path:info.outputPath('swap-override-checked.png')});
 await page.keyboard.press('Space');await expect(confirm).toBeDisabled();
 await page.keyboard.press('Escape');expect(backend.calls.filter(c=>c.name==='duty_save_schedule')).toHaveLength(0);
 await page.clock.setFixedTime(new Date(Date.parse(NOW)+1000));
 await propose(page,mobile);await expect(checkbox).not.toBeChecked();await expect(confirm).toBeDisabled();
 await label.click();await expect(checkbox).toBeChecked();
 let release!:()=>void;const gate=new Promise<void>(r=>{release=r});
 await page.route('**/rest/v1/rpc/duty_save_schedule',async route=>{await gate;await route.fallback()});
 const request=page.waitForRequest('**/rest/v1/rpc/duty_save_schedule');await confirm.click();await request;
 await expect(checkbox).toBeDisabled();const disabled=(await checkbox.boundingBox())!;expect(disabled.width).toBe(24);expect(disabled.height).toBe(24);
 await page.keyboard.press('Escape');await expect(dialog).toBeVisible();release();await expect(dialog).toBeHidden();
 const saved=backend.raw.assignments.find(d=>d.publication_id===null&&d.day==='2026-11-06')!;
 expect(saved.primary_id).toBe(ids.a);expect(saved.manager_override).toBe(true);
 expect(backend.raw.assignments.filter(d=>d.publication_id!==null)).toEqual(published);
 expect(backend.calls.filter(c=>c.name==='duty_save_schedule')).toHaveLength(1);
 await page.reload();await expect(duty(page,'2026-11-06')).toHaveAccessibleName(/Alex Atlas/);
});
