import {test,expect,ids} from './fixtures';

const net=(page:import('@playwright/test').Page,id:string)=>page.locator(`[data-gesture-key="${id}"] .net-points button`);

test.beforeEach(({backend})=>{
 // Projected from published schedules: a temporarily gave one point to b.
 backend.balance={net:{...Object.fromEntries(backend.raw.members.map(m=>[m.id,0])),[ids.a]:-2,[ids.b]:2},lines:[
  {memberId:ids.a,counterpartId:ids.b,units:-2,kind:'temporary',date:'2026-11-03',month:null},
  {memberId:ids.b,counterpartId:ids.a,units:2,kind:'temporary',date:'2026-11-03',month:null}]};
});

test('admin sees every projected net with a breakdown on focus, hover or tap, in English and Hebrew',async({page,openApp,backend},info)=>{
 await openApp();await page.getByRole('tab').nth(2).click();
 const name=(id:string)=>backend.raw.members.find(m=>m.id===id)!.name;
 await expect(net(page,ids.a)).toHaveText('−1net');
 await expect(net(page,ids.b)).toHaveText('+1net');
 await expect(net(page,ids.c)).toHaveText('0net');
 await net(page,ids.a).focus();
 const breakdown=page.locator('.net-breakdown');
 await expect(breakdown).toContainText(`${name(ids.b)} covered a duty · 3 Nov · temporary`);
 await page.keyboard.press('Escape');await expect(breakdown).toBeHidden();
 if(info.project.name==='mobile')await net(page,ids.b).tap();else await net(page,ids.b).hover();
 await expect(breakdown).toContainText(`Covered ${name(ids.a)}'s duty · 3 Nov · temporary`);
 await page.mouse.click(5,5);await expect(breakdown).toBeHidden();
 await page.getByRole('button',{name:'Switch to Hebrew',exact:true}).click();
 await net(page,ids.a).focus();
 await expect(breakdown).toHaveAttribute('dir','rtl');
 await expect(breakdown).toContainText('תורנות כוסתה על ידי');
 await expect(breakdown).toContainText('זמני');
 expect(backend.calls.filter(c=>c.name==='duty_balance').length).toBeGreaterThan(0);
});

test('an engineer sees only their own net balance',async({page,openApp})=>{
 await openApp('a');await page.getByRole('tab').nth(2).click();
 await expect(net(page,ids.a)).toHaveText('−1net');
 await expect(page.locator('.net-points button')).toHaveCount(1);
 await net(page,ids.a).click();
 await expect(page.locator('.net-breakdown')).toContainText('· temporary');
});
