import {test, expect, ids, touchEvent} from './fixtures';
import type {Page} from '@playwright/test';

const selector = '.gesture-grid.team-list > .team-row';
const rows = (page: Page) => page.locator(selector);
const order = (page: Page) => rows(page).evaluateAll(els => els.map(el => (el as HTMLElement).dataset.gestureKey!));
function gate() {
 let release!: () => void;
 const wait = new Promise<void>(resolve => {release = resolve;});
 return {wait, release};
}
type Frame = {order: string[]; ghost: boolean; busy: boolean; tops: number[]};
type Recording = {frames: Frame[]; running: boolean};

async function record(page: Page) {
 await page.evaluate(selector => {
  const recording: Recording = {frames: [], running: true};
  Object.assign(window, {teamRecording: recording});
  const sample = () => {
   const elements = [...document.querySelectorAll<HTMLElement>(selector)];
   const visual = elements.map(el => ({id: el.dataset.gestureKey!, top: el.getBoundingClientRect().top})).sort((a,b) => a.top-b.top);
   recording.frames.push({order: visual.map(p => p.id), tops: visual.map(p => p.top), ghost: !!document.querySelector('.mobile-drag-preview'), busy: document.querySelector('.gesture-grid.team-list')?.getAttribute('aria-busy') === 'true'});
   if (recording.running) requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
 }, selector);
}
async function finishRecording(page: Page) {
 return page.evaluate(() => {
  const recording = (window as unknown as {teamRecording: Recording}).teamRecording;
  recording.running = false;
  return recording.frames;
 });
}
async function drop(page: Page, mobile: boolean, from = 0, to = 2) {
 const handle = (await rows(page).nth(from).locator('.team-grip').boundingBox())!;
 const row = (await rows(page).nth(from).boundingBox())!, target = (await rows(page).nth(to).boundingBox())!;
 const x = handle.x+handle.width/2, y = handle.y+handle.height/2;
 if (mobile) {await touchEvent(page,'touchstart',x,y); await page.waitForTimeout(400);}
 else {await page.mouse.move(x,y); await page.mouse.down(); await page.mouse.move(x,y+7);}
 await expect(page.locator('.mobile-drag-preview')).toBeVisible();
 const end = y+target.y+target.height/2-row.y-row.height/2+2;
 if (mobile) await touchEvent(page,'touchmove',x,end);
 else await page.mouse.move(x,end,{steps:6});
 await record(page);
 if (mobile) await touchEvent(page,'touchend',x,end);
 else await page.mouse.up();
 await expect(page.locator('.mobile-drag-preview')).toHaveCount(0);
}

for (const lang of ['en','he'] as const) test(`optimistic drop survives latency, stale props and confirmation in ${lang}`, async ({page,openApp,backend},info) => {
 await page.emulateMedia({reducedMotion:'no-preference'});
 await page.setViewportSize({width:info.project.name==='mobile'?390:1440,height:1200});
 await openApp();
 if (lang==='he') await page.getByRole('button',{name:'Switch to Hebrew'}).click();
 await page.getByRole('tab').nth(2).click();await expect(page.locator('.team-list')).toBeVisible();
 const initial = await order(page), expected = [...initial.slice(1,3),initial[0],...initial.slice(3)];
 const stale = backend.snapshot(ids.admin), held = gate(), started = gate();
 let writes = 0, staleLoads = 0;
 const profile = {name:'Updated Atlas',color:'#abcdef',active:false,role:'admin'};
 await page.evaluate(selector => {
  Object.assign(window,{originalTeamNodes:[...document.querySelectorAll(selector)]});
 },selector);
 await page.route('**/rest/v1/rpc/duty_save_schedule',async route => {
  writes++; started.release(); await held.wait;
  const data = backend.rpc('duty_save_schedule',route.request().postDataJSON(),ids.admin);
  Object.assign(backend.raw.members.find(m=>m.id===ids.a)!,profile);
  Object.assign(stale.members.find(m=>m.id===ids.a)!,profile);
  await route.fulfill({json:data});
 });
 await page.route('**/rest/v1/rpc/duty_load',async route => {
  if (!staleLoads++) return route.fulfill({json:stale});
  return route.fallback();
 });
 try {
  await drop(page,info.project.name==='mobile');
  await started.wait;
  expect(await order(page)).toEqual(expected);
  await page.waitForTimeout(1500);
  await expect(rows(page).locator('.team-grip').first()).toBeDisabled();
  await page.keyboard.press('ArrowDown');
  expect(writes).toBe(1);
  const staleResponse = page.waitForResponse('**/rest/v1/rpc/duty_load');
  held.release(); await (await staleResponse).finished();
  await expect(rows(page).filter({hasText:'Updated Atlas'})).toHaveCount(1);
  const updated = page.locator(`${selector}[data-gesture-key="${ids.a}"]`);
  await expect(updated).toHaveClass(/inactive/);
  await expect(updated.locator('.avatar')).toHaveCSS('background-color','rgb(171, 205, 239)');
  await expect(updated.locator('.team-role select')).toHaveValue('admin');
  await page.waitForTimeout(350);
  expect(await order(page)).toEqual(expected);
  // The save has resolved but React only has the stale parent snapshot. Keep
  // the overlay and lock until a real acknowledgement or newer revision arrives.
  await expect(rows(page).locator('.team-grip').first()).toBeDisabled();
  const refreshed = page.waitForResponse('**/rest/v1/rpc/duty_load');
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await (await refreshed).finished();
  await expect(page.locator('.gesture-grid.team-list')).toHaveAttribute('aria-busy','false');
  await page.waitForTimeout(300);
  const frames = (await finishRecording(page)).filter(f=>!f.ghost);
  expect(frames.length).toBeGreaterThan(50);
  expect(frames.every(f=>JSON.stringify(f.order)===JSON.stringify(expected)),JSON.stringify(frames)).toBe(true);
  expect(frames.some(f=>f.busy)).toBe(true); expect(frames.some(f=>!f.busy)).toBe(true);
  expect(writes).toBe(1);
  expect(backend.calls.filter(c=>c.name==='duty_save_schedule')).toHaveLength(1);
  expect(await page.evaluate(selector => {
   const original = (window as unknown as {originalTeamNodes:Element[]}).originalTeamNodes;
   return [...document.querySelectorAll(selector)].every(el=>original.includes(el));
  },selector)).toBe(true);
  await expect(rows(page).locator('.team-grip span')).toHaveText(['1','2','3','4','5','6']);
  await test.info().attach('drop-through-confirmation-frames',{body:JSON.stringify(frames),contentType:'application/json'});
  // Reconciliation releases the lock; the next keyboard save uses revision 2.
  const handle=page.locator(`${selector}[data-gesture-key="${ids.admin}"] .team-grip`);
  await handle.focus(); await page.keyboard.press('ArrowUp');
  await expect(page.locator('.gesture-grid.team-list')).toHaveAttribute('aria-busy','false');
  await expect(handle).toBeFocused();
  expect(backend.calls.filter(c=>c.name==='duty_save_schedule').map(c=>c.params.p_revision)).toEqual([1,2]);
 } finally {held.release();}
});

for (const failure of ['network','revision conflict','external success'] as const) test(`pending reorder handles ${failure} without overwriting external data`,async({page,openApp,backend},info)=>{
 await page.emulateMedia({reducedMotion:'no-preference'});
 await page.setViewportSize({width:info.project.name==='mobile'?390:1440,height:1200});
 await openApp();
 if(failure==='network')await page.getByRole('button',{name:'Switch to Hebrew'}).click();
 await page.getByRole('tab').nth(2).click();await expect(page.locator('.team-list')).toBeVisible();
 const initial=await order(page), expected=[...initial.slice(1,3),initial[0],...initial.slice(3)];
 const held=gate(),started=gate();let writes=0;
 const external=[...initial].reverse();
 await page.route('**/rest/v1/rpc/duty_save_schedule',async route=>{
  writes++; started.release(); await held.wait;
  if(failure==='external success')backend.rpc('duty_save_schedule',route.request().postDataJSON(),ids.admin);
  if(failure!=='network'){
   backend.raw.members.sort((a,b)=>external.indexOf(a.id)-external.indexOf(b.id));
   backend.raw.members.forEach((m,i)=>m.seniority=i);
   backend.raw.members.find(m=>m.id===ids.b)!.name='External Birch';
   backend.raw.revision!++;
  }
  await route.fulfill(failure==='external success'?{json:null}:{status:failure==='network'?503:409,json:{code:failure==='network'?'503':'40001',message:failure==='network'?'Service temporarily unavailable.':'Workspace changed. Refresh and try again.'}});
 });
 try{
  await drop(page,info.project.name==='mobile');await started.wait;
  expect(await order(page)).toEqual(expected);
  await page.waitForTimeout(500);
  const before=(await finishRecording(page)).filter(f=>!f.ghost);
  expect(before.every(f=>JSON.stringify(f.order)===JSON.stringify(expected))).toBe(true);
  await record(page);
  held.release();
  await expect(page.locator('.gesture-grid.team-list')).toHaveAttribute('aria-busy','false');
  await expect.poll(()=>order(page)).toEqual(failure==='network'?initial:external);
  if(failure!=='external success'){
   await expect(page.locator('[data-sonner-toast]')).toHaveCount(1);
   await expect(page.locator('[data-sonner-toast]')).toContainText(failure==='network'?'לא ניתן לשנות את הסדר. נסו שוב.':'Could not reorder. Try again.');
   await expect(page.locator('[data-sonner-toast]')).toContainText(failure==='network'?'Service temporarily unavailable.':'Workspace changed. Refresh and try again.');
  }else await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);
  await page.waitForTimeout(350);
  const frames=await finishRecording(page);
  if(failure==='network'){
   const tops=frames.map(f=>f.tops[0]);
   expect(new Set(tops.map(n=>n.toFixed(1))).size,'rollback has intermediate animation positions').toBeGreaterThan(2);
  }else await expect(rows(page).filter({hasText:'External Birch'})).toHaveCount(1);
  expect(writes).toBe(1);
  await test.info().attach('rollback-or-external-frames',{body:JSON.stringify(frames),contentType:'application/json'});
 }finally{held.release();}
});

test('failed keyboard reorder retains focus and respects reduced motion',async({page,openApp,backend})=>{
 await openApp();await page.getByRole('tab').nth(2).click();await expect(page.locator('.team-list')).toBeVisible();
 const initial=await order(page),handle=rows(page).first().locator('.team-grip');
 backend.failNextSave=true;
 await handle.focus();await page.keyboard.press('ArrowDown');
 await expect(page.locator('[data-sonner-toast]')).toContainText('Synthetic stale revision');
 await expect.poll(()=>order(page)).toEqual(initial);
 await expect(handle).toBeFocused();
 expect(await rows(page).evaluateAll(els=>els.flatMap(el=>el.getAnimations()).length)).toBe(0);
 expect(backend.calls.filter(c=>c.name==='duty_save_schedule')).toHaveLength(1);
});

for(const width of [320,375,390,430])test(`inline grip fits ${width}px in English and Hebrew`,async({page,openApp},info)=>{
 test.skip(info.project.name!=='mobile','Phone layout matrix.');
 await page.setViewportSize({width,height:1000});await openApp();
 for(const lang of ['en','he']){
  if(lang==='he')await page.getByRole('button',{name:'Switch to Hebrew'}).click();
  await page.getByRole('tab').nth(2).click();await expect(page.locator('.team-list')).toBeVisible();
  const measurements=await rows(page).first().evaluate(el=>{
   const box=(selector:string)=>{const r=el.querySelector(selector)!.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}};
   const row=el.getBoundingClientRect();
   return{row:{y:row.y,height:row.height},handle:box('.team-grip'),icon:box('.team-grip svg'),rank:box('.team-grip span'),avatar:box('.avatar'),overflow:document.documentElement.scrollWidth>innerWidth};
  });
  const {row,handle,icon,rank,avatar}=measurements;
  expect(handle.width).toBeGreaterThanOrEqual(44);expect(handle.height).toBeGreaterThanOrEqual(44);
  expect(icon.width).toBe(25);expect(Math.abs(handle.y+handle.height/2-(row.y+row.height/2))).toBeLessThanOrEqual(.5); // Bottom border contributes half a pixel.
  expect(icon.y+icon.height/2).toBeCloseTo(rank.y+rank.height/2,1);
  expect(lang==='en'?icon.x<rank.x&&rank.x<avatar.x:icon.x>rank.x&&rank.x>avatar.x).toBe(true);
  expect(measurements.overflow).toBe(false);
  await page.screenshot({path:info.outputPath(`inline-grip-${width}-${lang}.png`),fullPage:true});
 }
});
