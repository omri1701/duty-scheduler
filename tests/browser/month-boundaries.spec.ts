import {test,expect,ids,touchEvent} from './fixtures';
import {webkit,devices} from '@playwright/test';
import {blocks,ownerMonth} from '../../lib/rota/engine';

for(const iphone of [false,true])for(const split of [false,true])for(const lang of ['en','he'] as const) {
  test(`month boundaries and real-date constraints ${iphone?'iPhone WebKit':'Chromium'} ${split?'split':'combined'} ${lang}`,async({page,backend,openApp},info)=>{
    test.skip(iphone&&info.project.name!=='desktop','One independent iPhone WebKit context.');
    const browser=iphone?await webkit.launch():null;
    try {
      if(browser)page=await (await browser.newContext({...devices['iPhone 13'],locale:'en-GB',timezoneId:'Asia/Jerusalem',reducedMotion:'reduce'})).newPage();
      backend.raw.assignments=[];backend.raw.publications=[];backend.raw.months=[];
      for(const month of ['2027-12','2028-01']) {
        const publication=`boundary-${month}`;
        backend.raw.months.push({month,deadline:month+'-01',status:'draft',generated:true,current_publication_id:publication,publication_sequence:1});
        backend.raw.publications.push({id:publication,month,version:1,published_at:'2026-10-01T00:00:00Z',published_by:ids.admin});
        for(const b of blocks(month,[],split?['2027-12-31']:[]).filter(b=>ownerMonth(b)===month)) {
          backend.raw.assignments.push({id:`${month}-${b.id}`,publication_id:publication,day:b.start,end_day:b.end,primary_id:ids.a,secondary_id:null,manager_override:false,title:'',extra_points:0,points:b.points});
        }
      }
      const schedule=structuredClone({months:backend.raw.months,assignments:backend.raw.assignments,publications:backend.raw.publications});
      await openApp('a',page);
      for(let i=0;i<13;i++)await page.getByRole('button',{name:'Next month',exact:true}).click();
      if(lang==='he')await page.getByRole('button',{name:'Switch to Hebrew',exact:true}).click();
      await expect(page.locator('.app-shell')).toHaveAttribute('dir',lang==='he'?'rtl':'ltr');
      const nav=page.locator('.month-title button');
      // Attach read-only captures before assertions so old/new builds can be reviewed.
      for(const month of ['2027-12','2028-01']) {
        for(const tab of [0,1]) {
          await page.getByRole('tab').nth(tab).click();
          expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
          await info.attach(`${month}-${tab===0?'schedule':'constraints'}-${lang}.png`,{body:await page.screenshot({fullPage:true,animations:'disabled'}),contentType:'image/png'});
        }
        if(month==='2027-12')await nav.last().click();
      }
      await nav.first().click();await page.getByRole('tab').nth(0).click();
      const grid=page.locator('.calendar-grid');
      await expect(grid.locator('[data-date]').first()).toHaveAttribute('data-date','2027-11-28');
      const last=grid.locator('[data-date]').last();
      await expect(last).toHaveAttribute('data-date',split?'2028-01-01':'2027-12-31');
      await expect(last).toBeEnabled();
      await expect(grid.locator('[data-date="2027-11-29"]')).toBeDisabled();
      await nav.last().click();
      await expect(grid.locator('[data-date]').first()).toHaveAttribute('data-date','2028-01-02');
      await expect(grid.locator('[data-date="2028-01-01"]')).toHaveCount(0);
      await page.getByRole('tab').nth(1).click();
      const days=page.locator('.availability-day');
      await expect(days.first().locator('strong')).toHaveText('2');
      await expect(days).toHaveCount(35);
      await nav.first().click();
      await expect(days).toHaveCount(35);
      const saturday=days.last(),friday=days.nth(33);
      await expect(saturday.locator('strong')).toHaveText('1');
      await expect(saturday).toBeEnabled();
      await expect(saturday).toHaveAttribute('data-gesture-key','2028-01-01');
      await expect(days.first()).toBeDisabled();
      await expect(days.first()).not.toHaveAttribute('data-gesture-key');
      await saturday.click();
      let dialog=page.getByRole('dialog');
      await expect(dialog).toContainText(lang==='en'?'1 January':'1 בינואר');
      await dialog.locator('textarea').fill('Actual Saturday');
      await dialog.getByRole('button',{name:lang==='en'?'Save':'שמירה',exact:true}).click();
      await expect(dialog).toHaveCount(0);
      expect(backend.calls.filter(c=>c.name==='duty_set_constraints').at(-1)?.params).toMatchObject({p_member:ids.a,p_days:['2028-01-01'],p_kind:'no',p_note:'Actual Saturday'});
      expect(backend.raw.constraints.find(c=>c.member_id===ids.a&&c.day==='2028-01-01')).toMatchObject({kind:'no',note:'Actual Saturday'});
      // A held range includes Saturday's actual date in both selection directions.
      for(const reverse of [false,true]) {
        const from=reverse?saturday:friday,to=reverse?friday:saturday;
        await from.evaluate(el=>el.scrollIntoView({block:'center'}));
        const a=(await from.boundingBox())!,b=(await to.boundingBox())!;
        const start={x:a.x+a.width/2,y:a.y+a.height/2},end={x:b.x+b.width/2,y:b.y+b.height/2};
        if(iphone||info.project.name==='mobile') {
          // WebKit does not expose a constructible Touch; supply the same event data.
          const touch=async(type:string,x:number,y:number)=>{
            if(!iphone)return touchEvent(page,type,x,y);
            await page.evaluate(({type,x,y})=>{
              const target=document.elementFromPoint(x,y)!,point={identifier:1,target,clientX:x,clientY:y};
              const event=new Event(type,{bubbles:true,cancelable:true});
              Object.defineProperties(event,{touches:{value:type==='touchend'?[]:[point]},changedTouches:{value:[point]}});
              target.dispatchEvent(event);
            },{type,x,y});
          };
          await touch('touchstart',start.x,start.y);await page.waitForTimeout(350);
          await expect(from).toHaveClass(/date-selected/);
          await touch('touchmove',end.x,end.y);await touch('touchend',end.x,end.y);
        } else {
          await page.mouse.move(start.x,start.y);await page.mouse.down();await page.waitForTimeout(350);
          await page.mouse.move(end.x,end.y,{steps:4});await page.mouse.up();
        }
        dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();
        await expect(page.locator('.date-selected')).toHaveCount(2);
        await page.keyboard.press('Escape');
      }
      await page.reload();
      for(let i=0;i<13;i++)await page.getByRole('button',{name:'Next month',exact:true}).click();
      await page.getByRole('tab').nth(1).click();
      await expect(days.last()).toHaveClass(/\bno\b/);
      await days.last().click();await expect(page.getByRole('dialog').locator('textarea')).toHaveValue('Actual Saturday');
      expect({months:backend.raw.months,assignments:backend.raw.assignments,publications:backend.raw.publications}).toEqual(schedule);
    } finally {await browser?.close();}
  });
}
