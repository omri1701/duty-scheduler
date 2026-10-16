import {test,expect,ids,MONTH} from './fixtures';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {blocks} from '../../lib/rota/engine';
import {publicCalendarCells} from '../../lib/rota/calendar-dates';

// This fixture has ordinary public weekends, short single-line assignments and
// no duties owned by the viewer. Private content/splits retain separate coverage.
function ordinaryCalendar(backend:import('./fixtures').Backend) {
  // Intentionally single-line content on both Linux and Windows fonts. The
  // full private fixture in startup-layout-capture keeps real name wrapping.
  backend.raw.members.forEach((member,i)=>{member.name=`Eng ${i}`});
  const publication=backend.raw.publications[0].id;
  backend.raw.assignments=blocks(MONTH,[]).flatMap((b,i)=>[null,publication].map(pub=>({id:`plain-${i}-${pub}`,publication_id:pub,day:b.start,end_day:b.end,primary_id:[ids.a,ids.b,ids.c,ids.d,ids.e][i%5],secondary_id:null,manager_override:false,title:'',extra_points:0,points:b.points})));
}

async function geometry(page:import('@playwright/test').Page) {
  return page.evaluate(()=>{
    const box=(el:Element)=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}};
    const detail=(el:Element)=>{const css=getComputedStyle(el);return {box:box(el),padding:[css.paddingTop,css.paddingRight,css.paddingBottom,css.paddingLeft],borders:[css.borderTopWidth,css.borderRightWidth,css.borderBottomWidth,css.borderLeftWidth],date:[...el.querySelectorAll('.date-line,.day-number')].map(box),chip:[...el.querySelectorAll('.assignment-chip')].map(box)}};
    const elements=Object.fromEntries(['.topbar','.top-actions>*','.workspace-status','.nav-row','.nav-row [data-slot=tabs-trigger]','.month-toolbar','.month-title','.month-title>*','.calendar-panel','.calendar-top','.calendar-top .segmented button','.calendar-weekdays span','.coverage-card','.fairness-card','.balance-row'].map(selector=>[selector,[...document.querySelectorAll(selector)].map(box)]));
    const grid=document.querySelector('.calendar-grid')!;
    return {elements,pageHeight:document.documentElement.scrollHeight,overflow:document.documentElement.scrollWidth-innerWidth,details:[...grid.querySelectorAll('.day-cell')].map(detail),grid:box(grid),cells:[...grid.querySelectorAll('.day-cell')].map(el=>({date:el.getAttribute('data-date')!,combined:el.classList.contains('combined-weekend'),...box(el)}))};
  });
}

function close(actual:number,expected:number,description:string) {
  expect(Math.abs(actual-expected),description).toBeLessThan(.1);
}

for(const width of [320,375,390,430,768,1440])for(const lang of ['en','he'])for(const role of ['manager','engineer']) {
  test(`public/verified geometry ${width}px ${lang} ${role}`,async({page,openApp,backend},info)=>{
    test.skip(info.project.name!=='desktop','Run the geometry matrix once.');
    await page.setViewportSize({width,height:900});
    backend.url='http://127.0.0.1:54321';backend.runtimeOrigin='http://localhost:8787';
    ordinaryCalendar(backend);
    if(role==='engineer')backend.raw.members.find(m=>m.id===ids.admin)!.role='engineer';
    await openApp('signed-out');
    if(lang==='he')await page.getByRole('button',{name:'\u05e2\u05d1\u05e8\u05d9\u05ea',exact:true}).click();
    let release!:()=>void;backend.authGate=new Promise<void>(resolve=>{release=resolve});
    await page.locator('input[type=password]').fill('synthetic-only');
    await page.locator('form.local-login button[type=submit]').click();
    const gallery=process.env.DUTY_STARTUP_GALLERY;
    const capture=async(phase:string)=>{const body=await page.screenshot({fullPage:true});await info.attach(phase,{body,contentType:'image/png'});if(gallery){mkdirSync(gallery,{recursive:true});writeFileSync(join(gallery,`after-${width}-${lang}-${role}-${phase}.png`),body)}};
    let shell!:Awaited<ReturnType<typeof geometry>>;
    try {
      await expect(page.locator('.startup-skeleton .day-cell')).toHaveCount(publicCalendarCells(MONTH).length);
      await expect(page.locator('.startup-skeleton')).toHaveAttribute('dir',lang==='he'?'rtl':'ltr');
      await expect(page.locator('.admin-avatar')).toHaveCount(0);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width);
      shell=await geometry(page);
      await capture('shell');
    } finally {release();}
    await expect(page.locator('.admin-avatar')).toBeVisible();
    const real=await geometry(page);
    await capture('real');
    if(gallery)writeFileSync(join(gallery,`after-${width}-${lang}-${role}.json`),JSON.stringify({width,lang,role,shell,real},null,2));
    expect(real.overflow).toBe(0);
    await info.attach('element-bounds',{body:JSON.stringify({width,lang,role,shell,real},null,2),contentType:'application/json'});

    for(const selector of ['.topbar','.top-actions>*','.workspace-status','.nav-row','.nav-row [data-slot=tabs-trigger]']) {
      const a=shell.elements[selector],b=real.elements[selector];
      expect(a.length,selector).toBe(b.length);
      a.forEach((rect,i)=>{for(const key of ['x','y','width','height'] as const)close(rect[key],b[i][key],`${selector} ${i} ${key}`)});
    }
    expect(shell.cells.map(c=>[c.date,c.combined])).toEqual(real.cells.map(c=>[c.date,c.combined]));
    close(shell.grid.x,real.grid.x,'absolute grid x');
    close(shell.grid.width,real.grid.width,'total grid width');
    close(shell.grid.height,real.grid.height,'total grid height');
    // Engineers have no private toolbar controls: assert absolute placement,
    // not just geometry relative to a potentially shifted outer container.
    if(role==='engineer')close(shell.grid.y,real.grid.y,'absolute grid y');
    const toolbarShift=real.elements['.month-toolbar'][0].height-shell.elements['.month-toolbar'][0].height;
    const controlsShift=real.elements['.calendar-top'][0].height-shell.elements['.calendar-top'][0].height;
    close(real.grid.y-shell.grid.y,toolbarShift+controlsShift,'only verified controls may offset grid');
    shell.details.forEach((detail,i)=>{
      const actual=real.details[i];
      expect(detail.padding).toEqual(actual.padding);expect(detail.borders).toEqual(actual.borders);
      for(const part of ['date','chip'] as const){
        expect(detail[part].length).toBe(actual[part].length);
        detail[part].forEach((rect,j)=>{
          close(rect.x-detail.box.x,actual[part][j].x-actual.box.x,`${i} ${part} x inset`);
          close(rect.y-detail.box.y,actual[part][j].y-actual.box.y,`${i} ${part} y inset`);
          close(rect.width,actual[part][j].width,`${i} ${part} width`);
          close(rect.height,actual[part][j].height,`${i} ${part} height`);
        });
      }
    });
    shell.cells.forEach((cell,i)=>{
      const actual=real.cells[i];
      close(cell.x,actual.x,`${cell.date} column`);
      close(cell.width,actual.width,`${cell.date} span`);
      close(cell.height,actual.height,`${cell.date} row height`);
      close(cell.y-shell.grid.y,actual.y-real.grid.y,`${cell.date} row position`);
    });
    // Month labels/status and manager actions legitimately depend on verified
    // status/role. Record absolute positions instead of hiding these differences.
    for(const i of [0,2]) {
      const a=shell.elements['.month-title>*'][i],b=real.elements['.month-title>*'][i];
      close(a.width,b.width,`month control ${i} width`);close(a.height,b.height,`month control ${i} height`);
      const shellRow=shell.elements['.month-title'][0],realRow=real.elements['.month-title'][0];
      close(a.y+a.height/2-shellRow.y-shellRow.height/2,b.y+b.height/2-realRow.y-realRow.height/2,`month control ${i} alignment`);
    }
    for(const selector of ['.calendar-weekdays span','.calendar-top .segmented button','.coverage-card']) {
      shell.elements[selector].forEach((rect,i)=>{
        close(rect.width,real.elements[selector][i].width,`${selector} ${i} width`);
        close(rect.height,real.elements[selector][i].height,`${selector} ${i} height`);
      });
    }
  });
}

test('pulse affects only placeholder content and is disabled by reduced motion',async({page,openApp,backend})=>{
  let release!:()=>void;backend.authGate=new Promise<void>(resolve=>{release=resolve});
  await openApp('admin',page,{waitForReady:false});
  try {
    await expect(page.locator('.skeleton-grid .day-cell').first()).toBeVisible();
    await page.emulateMedia({reducedMotion:'no-preference'});
    const animations=await page.locator('.startup-skeleton').evaluate(el=>el.getAnimations({subtree:true}).map(animation=>({name:(animation as CSSAnimation).animationName,placeholder:((animation.effect as KeyframeEffect).target as Element).classList.contains('skeleton-content'),duration:animation.effect!.getTiming().duration,frames:(animation.effect as KeyframeEffect).getKeyframes()})));
    expect(animations.length).toBeGreaterThan(30);
    expect(animations.every(a=>a.duration===2000)).toBe(true);
    const pulse=page.locator('.skeleton-grid .assignment-chip').first();
    const bounds=await pulse.boundingBox();
    const opacity=await pulse.evaluate(el=>getComputedStyle(el).opacity);
    await page.waitForTimeout(500);
    expect(await pulse.evaluate(el=>getComputedStyle(el).opacity)).not.toBe(opacity);
    expect(await pulse.boundingBox()).toEqual(bounds);
    expect(animations.every(a=>a.name==='placeholder-pulse'&&a.placeholder)).toBe(true);
    expect(animations.every(a=>a.frames.every(frame=>!('transform' in frame)&&!('width' in frame)&&!('height' in frame)))).toBe(true);
    await page.emulateMedia({reducedMotion:'reduce'});
    expect(await page.locator('.startup-skeleton').evaluate(el=>el.getAnimations({subtree:true}).length)).toBe(0);
  } finally {release();}
  await expect(page.locator('.startup-skeleton')).toHaveCount(0);
  expect(await page.evaluate(()=>document.getAnimations().filter(a=>(a as CSSAnimation).animationName==='placeholder-pulse').length)).toBe(0);
});

for(const [now,month] of [['2026-01-15T12:00:00Z','2026-02'],['2026-07-15T12:00:00Z','2026-08']]) {
  test(`public calendar follows browser month ${month} instead of the static build month`,async({page,openApp,backend},info)=>{
    test.skip(info.project.name!=='desktop');
    backend.url='http://127.0.0.1:54321';backend.runtimeOrigin='http://localhost:8787';
    await openApp('signed-out');
    await page.clock.setFixedTime(new Date(now));
    let release!:()=>void;backend.authGate=new Promise<void>(resolve=>{release=resolve});
    await page.locator('input[type=password]').fill('synthetic-only');
    await page.locator('form.local-login button[type=submit]').click();
    const expected=publicCalendarCells(month).map(cell=>cell.date);
    try {
      await expect(page.locator('.startup-skeleton .day-cell')).toHaveCount(expected.length);
      expect(await page.locator('.startup-skeleton .day-cell').evaluateAll(cells=>cells.map(cell=>cell.getAttribute('data-date')))).toEqual(expected);
    } finally {release();}
    await expect(page.locator('.admin-avatar')).toBeVisible();
    expect(await page.locator('.calendar-grid .day-cell').evaluateAll(cells=>cells.map(cell=>cell.getAttribute('data-date')))).toEqual(expected);
  });
}
