import {test,expect,ids,touchEvent} from './fixtures';
import type {Page} from '@playwright/test';

const rows=(page:Page)=>page.locator('.gesture-grid.team-list > .team-row');
const order=(page:Page)=>rows(page).evaluateAll(els=>els.map(el=>(el as HTMLElement).dataset.gestureKey));

for(const lang of ['en','he'] as const) test(`vertical team stack, cancellation, persistence and keyboard in ${lang}`,async({page,openApp,backend},info)=>{
 await page.emulateMedia({reducedMotion:'no-preference'});
 // Keep all measured rows visible on touch while varying heights and slot gaps.
 await page.setViewportSize({width:info.project.name==='mobile'?390:1440,height:1200});
 await openApp();
 if(lang==='he')await page.getByRole('button',{name:'Switch to Hebrew'}).click();
 await page.getByRole('tab').nth(2).click();
 await page.addStyleTag({content:`.gesture-grid.team-list > [data-gesture-key="${ids.a}"]{padding-block:22px}.gesture-grid.team-list > [data-gesture-key="${ids.c}"]{padding-block:18px}.gesture-grid.team-list > .team-row:nth-child(2){margin-bottom:11px}.gesture-grid.team-list > .team-row:nth-child(4){margin-bottom:7px}`});
 const initial=await order(page),mobile=info.project.name==='mobile';
 const calls=()=>backend.calls.filter(c=>c.name==='duty_save_schedule');
 async function start(from:number){
  const row=rows(page).nth(from),handle=row.locator('.team-grip');
  const a=(await handle.boundingBox())!,box=(await row.boundingBox())!;
  const x=a.x+a.width/2,y=a.y+a.height/2;
  if(mobile){await touchEvent(page,'touchstart',x,y);await page.waitForTimeout(400)}
  else{await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x,y+7)}
  await expect(page.locator('.mobile-drag-preview')).toBeVisible();
  return {x,y,box};
 }
 async function move(x:number,y:number){if(mobile)await touchEvent(page,'touchmove',x,y);else await page.mouse.move(x,y,{steps:6})}
 async function end(x:number,y:number){if(mobile)await touchEvent(page,'touchend',x,y);else{await page.mouse.move(x,y);await page.mouse.up()}}
 async function reorder(from:number,to:number){
  const before=await order(page),count=calls().length;
  const target=(await rows(page).nth(to).boundingBox())!;
  const a=await start(from);
  const y=a.y+target.y+target.height/2-(a.box.y+a.box.height/2)+(to>from?2:-2);
  const sideways=a.x+(a.x<a.box.x+a.box.width/2?70:-70);
  await move(sideways,y);
  const ghost=(await page.locator('.mobile-drag-preview').boundingBox())!;
  expect(ghost.x).toBeCloseTo(a.box.x,1);expect(ghost.width).toBeCloseTo(a.box.width,1);
  expect(calls()).toHaveLength(count);
  if(from===0&&to===3){
   // Inspect and assert real intermediate animation frames, rather than only
   // the committed order. Sideways movement never displaces the lifted row.
   const frames=await rows(page).nth(to).evaluate(async el=>{
    const result:number[]=[];
    for(let frame=0;frame<18;frame++){
     await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
     result.push(el.getBoundingClientRect().top);
    }
    return result;
   });
   expect(frames.at(-1)!).toBeLessThan(target.y-20);
   expect(frames.every((top,i)=>i===0||top<=frames[i-1]+.1)).toBe(true);
   await test.info().attach('neighbor-animation-frames',{body:JSON.stringify(frames),contentType:'application/json'});
  }
  await page.screenshot({path:info.outputPath(`team-${from}-to-${to}-drag.png`)});
  await end(sideways,y);
  const next=[...before];next.splice(to,0,next.splice(from,1)[0]);
  await expect.poll(()=>order(page)).toEqual(next);
  await expect.poll(()=>calls().length).toBe(count+1);
  await expect(page.locator('.team-list.gesture-grid')).toHaveAttribute('aria-busy','false');
  expect((calls().at(-1)!.params.p_state as {team:{id:string}[]}).team.map(p=>p.id)).toEqual(next);
  await expect(page.locator('.mobile-drag-preview')).toHaveCount(0);
  await page.screenshot({path:info.outputPath(`team-${from}-to-${to}-settled.png`)});
 }
 await reorder(0,3);await reorder(3,0);await reorder(0,1);await reorder(1,0);
 expect(await order(page)).toEqual(initial);
 for(const cancel of ['escape','pointercancel','touchcancel'] as const){
  if(cancel==='touchcancel'&&!mobile)continue;
  const a=await start(0),target=(await rows(page).nth(2).boundingBox())!;
  await move(a.x,target.y+target.height/2);
  if(cancel==='escape'){await page.keyboard.press('Escape');if(!mobile)await page.mouse.up()}
  else if(cancel==='touchcancel')await touchEvent(page,'touchcancel',a.x,target.y);
  else await page.evaluate(()=>document.dispatchEvent(new PointerEvent('pointercancel')));
  await expect(page.locator('.mobile-drag-preview')).toHaveCount(0);
  expect(await order(page)).toEqual(initial);expect(calls()).toHaveLength(4);
 }
 // Row content and role controls never start a desktop or touch drag.
 const body=(await rows(page).first().locator('.team-name').boundingBox())!;
 if(mobile){await touchEvent(page,'touchstart',body.x+5,body.y+5);await page.waitForTimeout(400)}
 else{await page.mouse.move(body.x+5,body.y+5);await page.mouse.down()}
 await move(body.x+5,body.y+80);await end(body.x+5,body.y+80);
 await expect(page.locator('.mobile-drag-preview')).toHaveCount(0);expect(calls()).toHaveLength(4);
 const handle=page.locator(`.gesture-grid.team-list > [data-gesture-key="${ids.admin}"] .team-grip`);await handle.focus();await page.keyboard.press('ArrowDown');
 await expect.poll(()=>calls().length).toBe(5);
 await expect.poll(()=>order(page)).toEqual([ids.a,ids.admin,...initial.slice(2)]);
 await expect(page.locator('[aria-live="polite"]').filter({hasText:'Avery Admin · 2'})).toHaveCount(1);
 await expect(handle).toBeFocused();
 await page.keyboard.press('ArrowUp');
 await expect.poll(()=>calls().length).toBe(6);
 await expect.poll(()=>order(page)).toEqual(initial);
});

test('engineers see the team in read-only mode with disabled reorder handles',async({page,openApp,backend})=>{
 await openApp('a');await page.getByRole('tab').nth(2).click();
 const initial=await order(page);
 for(const handle of await rows(page).locator('.team-grip').all())await expect(handle).toBeDisabled();
 expect(await order(page)).toEqual(initial);
 expect(backend.calls.filter(c=>c.name==='duty_save_schedule')).toHaveLength(0);
});
