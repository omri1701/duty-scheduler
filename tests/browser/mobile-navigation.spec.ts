import {test,expect} from './fixtures';
import type {Page} from '@playwright/test';

async function bounds(page:Page){
  return page.locator('.mobile-navigation').evaluate(node=>{
    const box=(element:Element)=>{const b=element.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height,right:b.right,bottom:b.bottom}};
    const row=getComputedStyle(node.parentElement!),pill=getComputedStyle(node),indicator=node.querySelector('.mobile-nav-selection')!;
    return {pill:box(node),indicator:box(indicator),tabs:[...node.querySelectorAll('[role=tab]')].map(box),
      radius:parseFloat(pill.borderTopLeftRadius),indicatorRadius:parseFloat(getComputedStyle(indicator).borderTopLeftRadius),
      safe:[row.getPropertyValue('--nav-safe-left'),row.getPropertyValue('--nav-safe-right'),row.getPropertyValue('--nav-safe-bottom')].map(parseFloat),viewport:innerWidth,height:innerHeight};
  });
}
function close(a:number,b:number,label:string){expect(Math.abs(a-b),label).toBeLessThan(.08)}
async function aligned(page:Page,index:number){
  const b=await bounds(page),selected=b.tabs[index],top=b.indicator.y-b.pill.y,bottom=b.pill.bottom-b.indicator.bottom;
  close(top,bottom,'top and bottom inset');
  close(b.indicator.x,selected.x,'indicator follows actual tab x');close(b.indicator.width,selected.width,'indicator equals actual track width');
  close(b.indicator.height,selected.height,'indicator equals actual track height');
  close(b.radius-b.indicatorRadius,top,'concentric rounded corners');
  const left=Math.min(...b.tabs.map(tab=>tab.x))-b.pill.x,right=b.pill.right-Math.max(...b.tabs.map(tab=>tab.right));
  close(left,top,'left outer track inset');close(right,top,'right outer track inset');
  for(const tab of b.tabs)close(tab.width,b.tabs[0].width,'equal tab tracks');
  close(b.pill.x-b.safe[0],b.viewport-b.pill.right-b.safe[1],'outer left/right safe margins');
  close(b.pill.x-b.safe[0],b.height-b.pill.bottom-b.safe[2],'outer side/bottom safe margins');
  return b;
}

for(const width of [320,375,390,430])for(const lang of ['en','he']){
  test(`navigation geometry and forgiving drag ${width}px ${lang}`,async({page,openApp,backend},info)=>{
    test.skip(info.project.name!=='mobile','Phone matrix.');
    await page.setViewportSize({width,height:900});await openApp();
    if(lang==='he')await page.getByRole('button',{name:'Switch to Hebrew'}).click();
    const tabs=page.getByRole('tab'),nav=page.locator('.mobile-navigation');
    // WebKit quantizes emulated mouse input. Check tracking against the actual
    // delivered pointer coordinates, retaining the same tight layout tolerance.
    await nav.evaluate(node=>{
      const host=node as HTMLElement,pointer={id:0,startX:0,x:0};Object.assign(window,{navTestPointer:pointer});
      host.addEventListener('pointerdown',event=>{pointer.id=event.pointerId;pointer.startX=pointer.x=event.clientX});
      host.addEventListener('pointermove',event=>{pointer.x=event.clientX});
    });
    for(const safe of [false,true]){
      if(safe)await page.addStyleTag({content:'.nav-row{--nav-safe-left:12px;--nav-safe-right:20px;--nav-safe-bottom:34px}'});
      for(const index of [0,1,2]){await tabs.nth(index).click();await aligned(page,index)}
    }
    await tabs.nth(0).click();const b=await aligned(page,0);
    const start=b.tabs[0],x=start.x+start.width*.28,y=start.y+start.height/2,direction=lang==='he'?-1:1;
    await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+direction*18,y);
    await expect(nav).toHaveAttribute('data-sliding','true');
    const pointer=()=>page.evaluate(()=>(window as unknown as {navTestPointer:{id:number;startX:number;x:number}}).navTestPointer);
    expect(await nav.evaluate((node,id)=>node.hasPointerCapture(id),(await pointer()).id)).toBe(true);
    await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve())));
    const first=await bounds(page);close(first.indicator.x-b.indicator.x,direction*18,'no jump at drag initiation');
    // The pointer is captured: go far outside the pill, reverse twice, and
    // release above it. Active selection changes only on successful release.
    for(const index of [2,0,2,1,2]){
      const target=b.tabs[index],dx=target.x-start.x,edge=index===2?direction*20:index===0?-direction*20:0;
      await page.mouse.move(x+dx+edge,y-350,{steps:5});
      await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve())));
      await expect(nav).toHaveAttribute('data-sliding','true');
      await expect(tabs.nth(0)).toHaveAttribute('aria-selected','true');
      const delivered=await pointer(),expected=Math.max(Math.min(...b.tabs.map(tab=>tab.x)),Math.min(Math.max(...b.tabs.map(tab=>tab.x)),b.indicator.x+delivered.x-delivered.startX));
      const moving=await bounds(page);close(moving.indicator.x,expected,'continuous captured tracking outside pill');
      if(index!==1)close(moving.indicator.x,target.x,'edge tracking preserves equal inset');
      close(moving.indicator.y-b.pill.y,b.indicator.y-b.pill.y,'vertical excursion keeps inset');
    }
    await page.mouse.up();await expect(tabs.nth(2)).toHaveAttribute('aria-selected','true');await aligned(page,2);
    await tabs.nth(0).click();
    for(const interruption of ['pointercancel','lostpointercapture','blur','Escape','resize']){
      const current=await bounds(page),from=current.tabs[0];
      await page.mouse.move(from.x+from.width/2,from.y+20);await page.mouse.down();
      await page.mouse.move(from.x+from.width/2+direction*30,from.y+20);
      await expect(nav).toHaveAttribute('data-sliding','true');
      if(interruption==='Escape')await page.keyboard.press('Escape');
      else if(interruption==='blur'||interruption==='resize')await page.evaluate(type=>window.dispatchEvent(new Event(type)),interruption);
      else await nav.dispatchEvent(interruption,{pointerId:(await pointer()).id});
      await page.mouse.up();await expect(nav).not.toHaveAttribute('data-sliding','true');
      await expect(tabs.nth(0)).toHaveAttribute('aria-selected','true');await aligned(page,0);
    }
    // A vertical-first pointer must never turn into a navigation drag.
    const a=(await bounds(page)).tabs[0];
    await page.mouse.move(a.x+a.width/2,a.y+20);await page.mouse.down();await page.mouse.move(a.x+a.width/2,a.y-140,{steps:5});await page.mouse.up();
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected','true');
    await expect(nav).not.toHaveAttribute('data-sliding','true');
    // Normal keyboard navigation and reduced-motion settling remain native.
    await tabs.nth(0).focus();await page.keyboard.press(lang==='he'?'ArrowLeft':'ArrowRight');
    await expect(tabs.nth(1)).toBeFocused();await aligned(page,1);
    expect(await nav.locator('.mobile-nav-selection').evaluate(node=>getComputedStyle(node).transitionDuration)).toBe('0s');
    await page.emulateMedia({reducedMotion:'no-preference'});
    expect(parseFloat(await nav.locator('.mobile-nav-selection').evaluate(node=>getComputedStyle(node).transitionDuration))).toBeGreaterThan(0);
    expect(backend.calls.filter(call=>call.name==='duty_save_schedule')).toEqual([]);
  });
}

test('native touch keeps scrolling vertical-first and keeps a horizontal drag above the pill',async({page,openApp,browserName},info)=>{
  test.skip(info.project.name!=='mobile'||browserName!=='chromium','CDP exercises actual Chromium touch arbitration; shared pointer cases also run in WebKit.');
  await openApp();const client=await page.context().newCDPSession(page),tabs=page.getByRole('tab'),nav=page.locator('.mobile-navigation');
  const b=await bounds(page),from=b.tabs[0],to=b.tabs[2],x=from.x+from.width/2,y=from.y+20;
  const touch=(type:'touchStart'|'touchEnd'|'touchMove'|'touchCancel',tx=x,ty=y)=>client.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'||type==='touchCancel'?[]:[{x:tx,y:ty}]});
  await touch('touchStart');await touch('touchMove',x+22,y);
  await expect(nav).toHaveAttribute('data-sliding','true');
  for(let step=1;step<=8;step++)await touch('touchMove',x+(to.x-from.x)*step/8,y-300*step/8);
  await expect(nav).toHaveAttribute('data-sliding','true');await touch('touchEnd');
  await expect(tabs.nth(2)).toHaveAttribute('aria-selected','true');await aligned(page,2);
  await tabs.nth(0).click();await page.evaluate(()=>scrollTo(0,0));
  await touch('touchStart');for(let step=1;step<=8;step++)await touch('touchMove',x,y-260*step/8);await touch('touchEnd');
  await expect.poll(()=>page.evaluate(()=>scrollY)).toBeGreaterThan(0);
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected','true');await expect(nav).not.toHaveAttribute('data-sliding','true');
});
