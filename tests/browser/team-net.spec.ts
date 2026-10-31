import {test,expect,ids} from './fixtures';

const net=(page:import('@playwright/test').Page,id:string)=>page.locator(`[data-gesture-key="${id}"] .net-points button`);

test.beforeEach(({backend})=>{
 // Projected from published schedules: a temporarily gave one point to b.
 // An uneven month credited half a point from d to c.
 backend.balance={net:{...Object.fromEntries(backend.raw.members.map(m=>[m.id,0])),[ids.a]:-2,[ids.b]:2,[ids.c]:1,[ids.d]:-1},lines:[
  {memberId:ids.a,counterpartId:ids.b,units:-2,kind:'temporary',date:'2026-11-03',month:null},
  {memberId:ids.b,counterpartId:ids.a,units:2,kind:'temporary',date:'2026-11-03',month:null},
  {memberId:ids.c,counterpartId:ids.d,units:1,kind:'uneven',date:'2026-11-10',month:null},
  {memberId:ids.d,counterpartId:ids.c,units:-1,kind:'uneven',date:'2026-11-10',month:null}]};
});

test('admin sees every projected net with a breakdown on focus, hover or tap, in English and Hebrew',async({page,openApp,backend},info)=>{
 await openApp();await page.getByRole('tab').nth(2).click();
 const name=(id:string)=>backend.raw.members.find(m=>m.id===id)!.name;
 await expect(net(page,ids.a)).toHaveText('−1net');
 await expect(net(page,ids.b)).toHaveText('+1net');
 await expect(net(page,ids.c)).toHaveText('+0.5net');
 await expect(net(page,ids.e)).toHaveText('0net');
 await net(page,ids.c).focus();
 await expect(page.locator('.net-breakdown')).toContainText('Uneven monthly split · 10 Nov · temporary');
 // A lone half cannot be repaid by whole duties: it waits for its second half.
 await expect(page.locator('.net-breakdown')).toContainText('0.5 waiting for the second half');
 await page.keyboard.press('Escape');
 await net(page,ids.a).focus();
 const breakdown=page.locator('.net-breakdown');
 await expect(breakdown).toContainText(`${name(ids.b)} covered a duty · 3 Nov · temporary`);
 await expect(breakdown).not.toContainText('waiting for the second half');
 await page.keyboard.press('Escape');await expect(breakdown).toBeHidden();
 if(info.project.name==='mobile')await net(page,ids.b).tap();else await net(page,ids.b).hover();
 await expect(breakdown).toContainText(`Covered ${name(ids.a)}'s duty · 3 Nov · temporary`);
 await page.mouse.click(5,5);await expect(breakdown).toBeHidden();
 await page.getByRole('button',{name:'Switch to Hebrew',exact:true}).click();
 await net(page,ids.a).focus();
 await expect(breakdown).toHaveAttribute('dir','rtl');
 await expect(breakdown).toContainText('תורנות כוסתה על ידי');
 await expect(breakdown).toContainText('זמני');
 await page.keyboard.press('Escape');
 await net(page,ids.d).focus();
 await expect(breakdown).toContainText('חלוקה חודשית לא שווה');
 await expect(breakdown).toContainText('0.5 ממתין לחצי השני');
 expect(backend.calls.filter(c=>c.name==='duty_balance').length).toBeGreaterThan(0);
});

test('an engineer sees only their own net balance',async({page,openApp})=>{
 await openApp('a');await page.getByRole('tab').nth(2).click();
 await expect(net(page,ids.a)).toHaveText('−1net');
 await expect(page.locator('.net-points button')).toHaveCount(1);
 await net(page,ids.a).click();
 await expect(page.locator('.net-breakdown')).toContainText('· temporary');
});
