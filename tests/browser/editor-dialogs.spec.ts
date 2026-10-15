import {test,expect,duty,ids} from './fixtures';
import type {Page,Locator} from '@playwright/test';

async function centered(page:Page,dialog:Locator){
 const box=(await dialog.boundingBox())!,viewport=page.viewportSize()!;
 expect(Math.abs(box.x+box.width/2-viewport.width/2)).toBeLessThan(1);
 expect(Math.abs(box.y+box.height/2-viewport.height/2)).toBeLessThan(1);
 expect(box.x).toBeGreaterThanOrEqual(12);expect(box.y).toBeGreaterThan(0);
}

test('duty modal dismisses local edits, keeps nested selects open, restores focus and locks pending saves',async({page,openApp,backend},info)=>{
 await openApp();
 const cell=duty(page,'2026-11-02'),dialog=page.getByRole('dialog',{name:'Edit duty',exact:true});
 for(const dismissal of ['outside','escape','close']){
  await cell.click();await centered(page,dialog);
  await page.getByRole('combobox',{name:'Primary engineer',exact:true}).click();
  // Radix temporarily hides the dialog from the accessibility tree while its
  // modal select owns focus; the editor must remain visually mounted.
  await expect(page.getByRole('listbox')).toBeVisible();await expect(page.locator('.duty-dialog')).toBeVisible();
  await page.getByRole('option',{name:'Drew Dale',exact:true}).click();
  await expect(dialog).toBeVisible();
  if(dismissal==='outside')await page.mouse.click(5,5);
  else if(dismissal==='escape')await page.keyboard.press('Escape');
  else await dialog.getByRole('button',{name:'Close',exact:true}).click();
  await expect(dialog).toBeHidden();await expect(cell).toBeFocused();
  expect(backend.calls.filter(c=>c.name==='duty_save_schedule')).toHaveLength(0);
 }
 await cell.click();await expect(page.getByRole('combobox',{name:'Primary engineer',exact:true})).toContainText('Alex Atlas');
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve});
 await page.route('**/rest/v1/rpc/duty_save_schedule',async route=>{await gate;await route.fallback()});
 const request=page.waitForRequest('**/rest/v1/rpc/duty_save_schedule');
 await dialog.getByRole('button',{name:'Save assignment',exact:true}).click();await request;
 await expect(dialog.getByRole('button',{name:'Save assignment',exact:true})).toBeDisabled();
 await expect(dialog.getByRole('button',{name:'Close',exact:true})).toBeDisabled();
 await page.keyboard.press('Escape');await page.mouse.click(5,5);await expect(dialog).toBeVisible();
 release();await expect(dialog).toBeHidden();
 expect(backend.calls.filter(c=>c.name==='duty_save_schedule')).toHaveLength(1);
 await page.screenshot({path:info.outputPath('duty-dismissed.png')});
});

test('availability is centered, supports every dismissal, and discards unsaved notes without writes',async({page,openApp,backend})=>{
 backend.raw.months[0].current_publication_id=null;
 await openApp('a');await page.getByRole('tab').nth(1).click();
 const cell=page.locator('.availability-day[data-gesture-key="2026-11-04"]');
 for(const dismissal of ['outside','escape','close']){
  await cell.click();const dialog=page.getByRole('dialog');await centered(page,dialog);
  await expect(page.getByLabel('Description (optional)')).toHaveValue('Synthetic vacation');
  await page.getByLabel('Description (optional)').fill('Unsaved local changes');
  if(dismissal==='outside')await page.mouse.click(5,5);
  else if(dismissal==='escape')await page.keyboard.press('Escape');
  else await dialog.getByRole('button',{name:'Close',exact:true}).click();
  await expect(dialog).toBeHidden();await expect(cell).toBeFocused();
  await expect(cell).toHaveAttribute('aria-pressed','false');
 }
 expect(backend.calls.filter(c=>c.name==='duty_set_constraints')).toHaveLength(0);
});

test('bulk blank description clears notes only after confirmation and reconfirms changed data',async({page,openApp,backend},info)=>{
 backend.raw.constraints.push({member_id:ids.admin,day:'2026-11-05',kind:'no',note:'Existing note'});
 await openApp();await page.getByRole('tab').nth(1).click();
 const first=page.locator('.availability-day[data-gesture-key="2026-11-05"]'),last=page.locator('.availability-day[data-gesture-key="2026-11-09"]');
 const a=(await first.boundingBox())!,b=(await last.boundingBox())!;
 await page.mouse.move(a.x+a.width/2,a.y+a.height/2);await page.mouse.down();
 await page.mouse.move(b.x+b.width/2,b.y+b.height/2,{steps:4});await page.mouse.up();
 await page.getByRole('button',{name:'Prefer duty',exact:true}).click();
 await page.getByRole('button',{name:'Save',exact:true}).click();
 const confirmation=page.getByRole('alertdialog');await expect(confirmation).toContainText('description is blank');
 await page.screenshot({path:info.outputPath('overwrite-confirmation.png')});
 // A refresh cannot reuse consent for a different set of existing values.
 backend.raw.constraints.find(c=>c.member_id===ids.admin)!.note='Changed while confirming';backend.raw.revision!++;
 const loaded=page.waitForResponse('**/rest/v1/rpc/duty_load');
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await loaded;
 await expect(page.locator('.availability-day[data-gesture-key="2026-11-05"]')).toHaveAttribute('aria-label',/Changed while confirming/);
 await confirmation.getByRole('button',{name:'Replace and save',exact:true}).click();
 await expect(confirmation).toContainText('Availability changed');
 expect(backend.calls.filter(c=>c.name==='duty_set_constraints')).toHaveLength(0);
 await confirmation.getByRole('button',{name:'Replace and save',exact:true}).click();
 await expect(page.getByRole('dialog')).toBeHidden();
 const saved=backend.raw.constraints.filter(c=>c.member_id===ids.admin);
 expect(saved).toHaveLength(5);expect(saved.every(c=>c.kind==='prefer'&&c.note==='')).toBe(true);
 expect(backend.calls.filter(c=>c.name==='duty_set_constraints')).toHaveLength(1);
});
