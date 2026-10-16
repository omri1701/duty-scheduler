import {test,expect,ids,duty,touchEvent,NOW} from './fixtures';
import type {Page,Locator} from '@playwright/test';

const day=(page:Page,date:string)=>page.locator(`.availability-day[data-gesture-key="${date}"]`);
for(const lang of ['en','he'] as const){
 test(`removal follows persisted dates and person, with note consent in ${lang}`,async({page,openApp,backend})=>{
  backend.raw.constraints.push({member_id:ids.admin,day:'2026-11-06',kind:'prefer',note:''});
  await openApp();
  if(lang==='he')await page.getByRole('button',{name:'Switch to Hebrew'}).click();
  await page.getByRole('tab').nth(1).click();
  const remove=page.locator('.remove-constraint');
  await day(page,'2026-11-05').click();
  await expect(remove).toHaveCount(0);
  await page.locator('.constraint-choices button').nth(1).click();
  await page.locator('.editor-dialog textarea').fill('Only an unsaved note');
  await expect(remove).toHaveCount(0);
  await expect(page.getByRole('dialog').getByRole('button',{name:lang==='en'?'Cancel':'ביטול',exact:true})).toHaveCount(0);
  await page.keyboard.press('Escape');
  await day(page,'2026-11-06').click();await expect(remove).toBeVisible();await page.keyboard.press('Escape');
  // A mixed range uses actual saved state even if its first date is empty.
  const a=(await day(page,'2026-11-05').boundingBox())!,b=(await day(page,'2026-11-07').boundingBox())!;
  await page.mouse.move(a.x+a.width/2,a.y+a.height/2);await page.mouse.down();
  await page.mouse.move(b.x+b.width/2,b.y+b.height/2,{steps:4});await page.mouse.up();
  await expect(remove).toBeVisible();await page.keyboard.press('Escape');
  await page.clock.setFixedTime(new Date(Date.parse(NOW)+1000));
  // The same date is empty for the manager, and constrained with a note for Alex.
  await day(page,'2026-11-04').click();await expect(remove).toHaveCount(0);await page.keyboard.press('Escape');
  await page.getByRole('combobox').click();await page.getByRole('option',{name:'Alex Atlas',exact:true}).click();
  await day(page,'2026-11-04').click();await expect(remove).toBeVisible();await remove.click();
  const confirm=page.getByRole('alertdialog');
  const cancel=confirm.getByRole('button',{name:lang==='en'?'Cancel':'ביטול',exact:true});
  await expect(cancel).toBeVisible();await cancel.click();
  expect(backend.calls.filter(c=>c.name==='duty_set_constraints')).toHaveLength(0);
  await remove.click();await confirm.locator('.editor-actions button').last().click();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(backend.raw.constraints.some(c=>c.member_id===ids.a&&c.day==='2026-11-04')).toBe(false);
  await day(page,'2026-11-04').click();await expect(remove).toHaveCount(0);
  // Incoming persisted changes update the action while the editor is open.
  backend.raw.constraints.push({member_id:ids.a,day:'2026-11-04',kind:'no',note:'Added remotely'});backend.raw.revision!++;
  const loaded=page.waitForResponse('**/rest/v1/rpc/duty_load');
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await loaded;
  await expect(remove).toBeVisible();await page.keyboard.press('Escape');
  await page.locator('.month-title button').last().click();
  await day(page,'2026-12-04').click();await expect(remove).toHaveCount(0);
 });

 test(`override stays square, wraps and retains keyboard consent in ${lang}`,async({page,openApp},info)=>{
  await openApp();if(lang==='he')await page.getByRole('button',{name:'Switch to Hebrew'}).click();
  await duty(page,'2026-11-04').click();
  await page.getByRole('combobox').first().click();await page.getByRole('option',{name:/Alex Atlas/}).click();
  const checkbox=page.locator('.duty-override [role=checkbox]'),label=page.locator('.duty-override'),save=page.locator('.duty-dialog .editor-actions button');
  await label.evaluate(el=>{el.style.maxWidth='145px'});
  const box=(await checkbox.boundingBox())!,labelBox=(await label.boundingBox())!;
  expect(box.width).toBe(24);expect(box.height).toBe(box.width);expect(labelBox.height).toBeGreaterThan(44);
  expect(box.y-labelBox.y).toBe(10);
  expect(lang==='he'?box.x>labelBox.x+labelBox.width/2:box.x<labelBox.x+labelBox.width/2).toBe(true);
  await expect(save).toBeDisabled();await checkbox.focus();await page.keyboard.press('Space');
  await expect(checkbox).toBeChecked();await expect(save).toBeEnabled();
  const check=(await checkbox.locator('svg').boundingBox())!;
  expect(check.x+check.width/2).toBeCloseTo(box.x+box.width/2,0);expect(check.y+check.height/2).toBeCloseTo(box.y+box.height/2,0);
  await page.screenshot({path:info.outputPath(`override-${lang}-checked.png`)});
  await page.keyboard.press('Space');await expect(checkbox).not.toBeChecked();await expect(save).toBeDisabled();
  await page.screenshot({path:info.outputPath(`override-${lang}-unchecked.png`)});
  await label.click();await expect(checkbox).toBeChecked();
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve});
  await page.route('**/rest/v1/rpc/duty_save_schedule',async route=>{await gate;await route.fallback()});
  const request=page.waitForRequest('**/rest/v1/rpc/duty_save_schedule');await save.click();await request;
  await expect(checkbox).toBeDisabled();
  const disabledBox=(await checkbox.boundingBox())!;expect(disabledBox.height).toBe(disabledBox.width);
  await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toBeVisible();
  release();await expect(page.getByRole('dialog')).toBeHidden();
 });
}

async function legible(page:Page,control:Locator){
 await control.focus();
 const frames=await control.evaluate(async el=>{
  const samples=[];
  for(let i=0;i<14;i++){
   let node:Element|null=el,minScale=1;
   while(node){const css=getComputedStyle(node);if(css.transform!=='none'){const m=new DOMMatrix(css.transform);minScale*=Math.min(Math.hypot(m.a,m.b),Math.hypot(m.c,m.d))}node=node.parentElement}
   samples.push({font:parseFloat(getComputedStyle(el).fontSize),minScale,scale:visualViewport!.scale,width:document.documentElement.scrollWidth});
   await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
  }
  return samples;
 });
 for(const frame of frames){expect(frame.font).toBeGreaterThanOrEqual(16);expect(frame.minScale).toBeGreaterThanOrEqual(1);expect(frame.scale).toBe(1);expect(frame.width).toBe(page.viewportSize()!.width)}
}
for(const width of [320,375,390,430])test(`editable focus has no scaled ancestors or viewport drift at ${width}px`,async({page,openApp,browserName},info)=>{
 test.skip(info.project.name!=='mobile','Phone focus matrix.');
 await page.setViewportSize({width,height:844});await page.emulateMedia({reducedMotion:'no-preference'});
 await openApp();await page.getByRole('tab').nth(1).click();await day(page,'2026-11-05').click();
 await legible(page,page.locator('.editor-dialog textarea'));
 await page.evaluate(()=>{Object.defineProperty(visualViewport!,'height',{configurable:true,value:innerHeight-300});visualViewport!.dispatchEvent(new Event('resize'))});
 await expect.poll(async()=>{const b=(await page.getByRole('dialog').boundingBox())!;return b.y+b.height}).toBeLessThanOrEqual(544);
 await legible(page,page.locator('.editor-dialog textarea'));
 await page.evaluate(()=>{delete (visualViewport as unknown as {height?:number}).height;visualViewport!.dispatchEvent(new Event('resize'))});
 await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toBeHidden();
 await expect.poll(()=>page.evaluate(()=>visualViewport!.scale)).toBe(1);
 await page.getByRole('tab').nth(0).click();await page.getByRole('button',{name:'Special block',exact:true}).click();
 for(const input of await page.getByRole('dialog').locator('input').all())await legible(page,input);
 // User text enlargement is retained, rather than capped at 16px.
 await page.addStyleTag({content:':root{font-size:20px}'});
 await expect.poll(()=>page.getByRole('dialog').locator('input').first().evaluate(el=>getComputedStyle(el).fontSize)).toBe('20px');
 const viewport=await page.locator('meta[name=viewport]').getAttribute('content');
 expect(viewport).not.toMatch(/user-scalable\s*=\s*no|maximum-scale/);
 if(browserName==='chromium'){
  // Exercise page zoom independently of focus. This is not a native pinch test.
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('Emulation.setPageScaleFactor',{pageScaleFactor:2});
  await page.getByRole('dialog').locator('input').first().focus();
  await expect.poll(()=>page.evaluate(()=>visualViewport!.scale)).toBe(2);
  await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toBeHidden();
  await expect.poll(()=>page.evaluate(()=>visualViewport!.scale)).toBe(2);
  await cdp.send('Emulation.setPageScaleFactor',{pageScaleFactor:1});await cdp.detach();
 }
});

for(const lang of ['en','he'] as const)test(`edge drops, sideways tracking, auto-scroll and rollback in ${lang}`,async({page,openApp,backend},info)=>{
 const mobile=info.project.name==='mobile';
 const template=backend.raw.members[1];
 for(let i=0;i<20;i++)backend.raw.members.push({...template,id:`30000000-0000-4000-8000-${String(i).padStart(12,'0')}`,name:`Synthetic teammate ${i}`,email:`extra${i}@example.invalid`,seniority:7+i});
 await openApp();if(lang==='he')await page.getByRole('button',{name:'Switch to Hebrew'}).click();await page.getByRole('tab').nth(2).click();
 const rows=page.locator('.gesture-grid.team-list > .team-row'),order=()=>rows.evaluateAll(els=>els.map(el=>el.getAttribute('data-gesture-key'))),calls=()=>backend.calls.filter(c=>c.name==='duty_save_schedule');
 const initial=await order();
 async function start(index:number){
  const handle=rows.nth(index).locator('.team-grip');await handle.evaluate(el=>el.scrollIntoView({block:'center'}));await expect(handle).toBeEnabled();const b=(await handle.boundingBox())!;
  const x=b.x+b.width/2,y=b.y+b.height/2;
  if(mobile){await touchEvent(page,'touchstart',x,y);await page.waitForTimeout(400)}else{await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x,y+7)}
  await expect(page.locator('.mobile-drag-preview')).toBeVisible();return (await page.locator('.mobile-drag-preview').boundingBox())!;
 }
 async function move(y:number){if(mobile)await touchEvent(page,'touchmove',1,y);else await page.mouse.move(1,y)}
 async function end(y:number){if(mobile)await touchEvent(page,'touchend',1,y);else await page.mouse.up()}
 const height=page.viewportSize()!.height;
 const ghost=await start(0);await move(height-2);
 await expect.poll(()=>page.evaluate(()=>scrollY)).toBeGreaterThan(0);
 // Keep the finger still: insertion must advance as the list scrolls beneath it.
 await expect.poll(()=>rows.last().evaluate(el=>el.getBoundingClientRect().bottom),{timeout:15000}).toBeLessThan(height-2);
 const floated=(await page.locator('.mobile-drag-preview').boundingBox())!;expect(floated.x).toBeCloseTo(ghost.x,1);
 expect(calls()).toHaveLength(0);await end(height-2);
 await expect.poll(()=>order()).toEqual([...initial.slice(1),initial[0]]);expect(calls()).toHaveLength(1);
 const stopped=await page.evaluate(()=>scrollY);await page.waitForTimeout(120);expect(await page.evaluate(()=>scrollY)).toBe(stopped);
 await start(initial.length-1);await move(2);
 await expect.poll(()=>rows.first().evaluate(el=>el.getBoundingClientRect().top),{timeout:15000}).toBeGreaterThan(2);
 await end(2);await expect.poll(()=>order()).toEqual(initial);expect(calls()).toHaveLength(2);
 // A real failed write restores the original order after the edge drop.
 backend.failNextSave=true;await start(1);await move(2);await end(2);
 await expect.poll(()=>calls().length).toBe(3);await expect(page.locator('.gesture-grid.team-list')).toHaveAttribute('aria-busy','false');
 expect(await order()).toEqual(initial);
 // Cancellation stops edge scrolling immediately, with no persistence.
 await start(0);await move(height-2);await page.keyboard.press('Escape');if(!mobile)await page.mouse.up();
 await expect(page.locator('.mobile-drag-preview')).toHaveCount(0);const canceled=await page.evaluate(()=>scrollY);await page.waitForTimeout(120);
 expect(await page.evaluate(()=>scrollY)).toBe(canceled);expect(calls()).toHaveLength(3);
});
