import {test,expect,duty,ids,openDutySheet, switchLanguage} from './fixtures';
import type {Page,Locator} from '@playwright/test';

/** Every editor is a Sheet (decision 2026-11-06): a bottom sheet on phones, a side panel on PC. It never
 * leaves the viewport and never widens the page. */
async function fits(page:Page,dialog:Locator){
 const box=(await dialog.boundingBox())!,viewport=page.viewportSize()!;
 expect(box.x).toBeGreaterThanOrEqual(0);expect(box.y).toBeGreaterThanOrEqual(0);
 expect(box.x+box.width).toBeLessThanOrEqual(viewport.width+.5);expect(box.y+box.height).toBeLessThanOrEqual(viewport.height+.5);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
}
const schedule=(page:Page)=>page.getByRole('tab',{name:'Schedule',exact:true}).click();
/** The duty sheet's Edit opens the editor. */
async function editDuty(page:Page,day:string){
 const sheet=await openDutySheet(page,day);
 await sheet.getByRole('button',{name:/^(Edit|עריכה)$/}).click();
 await expect(page.locator('.duty-dialog')).toBeVisible();
}

for(const lang of ['en','he'] as const)for(const weekend of [
 {friday:'2026-11-06',sunday:'2026-11-08',previous:0,en:'Fri 6 – Sat 7 Nov · 1 pt',he:'יום ו׳, 6 בנוב׳ – שבת, 7 בנוב׳ · 1 נק׳'},
 {friday:'2026-07-31',sunday:'2026-08-02',previous:4,en:'Fri 31 Jul – Sat 1 Aug · 1 pt',he:'יום ו׳, 31 ביולי – שבת, 1 באוג׳ · 1 נק׳'},
])test(`weekend editor shows one weekend and two days ${lang} ${weekend.friday}`,async({page,openApp,backend},info)=>{
 if(weekend.previous){
  backend.raw.months.push({month:'2026-07',deadline:'2026-06-24',status:'draft',generated:true,current_publication_id:null,publication_sequence:0});
  backend.raw.assignments.push({id:'boundary-weekend',publication_id:null,day:weekend.friday,end_day:weekend.sunday,primary_id:ids.admin,secondary_id:ids.c,manager_override:false,title:'',extra_points:0,points:1});
 }
 const original=backend.raw.assignments.find(row=>row.day===weekend.friday&&row.publication_id===null)!;
 await openApp();
 await schedule(page);
 for(let i=0;i<weekend.previous;i++)await page.getByRole('button',{name:'Previous month',exact:true}).click();
 if(lang==='he')await switchLanguage(page, 'he');
 await editDuty(page,weekend.friday);
 const dialog=page.locator('.duty-dialog'),description=dialog.locator('.sheet-description');
 await expect(dialog).toHaveAttribute('dir',lang==='he'?'rtl':'ltr');
 await expect(description).toHaveText(weekend[lang]);
 await expect(dialog.getByRole('radio',{name:lang==='en'?'One weekend':'סוף שבוע אחד',exact:true})).toHaveAttribute('aria-checked','true');
 await expect(dialog.getByRole('combobox',{name:lang==='en'?'Primary engineer':'מהנדס ראשי',exact:true})).toBeVisible();
 await fits(page,dialog);
 // Two days: each date its own card; switching back with the same person just joins.
 await dialog.getByRole('radio',{name:lang==='en'?'Two days':'שני ימים',exact:true}).click();
 await expect(dialog.getByRole('combobox',{name:lang==='en'?'Friday primary engineer':'מהנדס ראשי ביום שישי',exact:true})).toBeVisible();
 await expect(dialog.getByRole('combobox',{name:lang==='en'?'Saturday primary engineer':'מהנדס ראשי ביום שבת',exact:true})).toBeVisible();
 await fits(page,dialog);
 await dialog.screenshot({path:info.outputPath(`weekend-${lang}.png`)});
 await dialog.getByRole('radio',{name:lang==='en'?'One weekend':'סוף שבוע אחד',exact:true}).click();
 await expect(dialog.getByRole('combobox',{name:lang==='en'?'Primary engineer':'מהנדס ראשי',exact:true})).toBeVisible();
 await dialog.getByRole('button',{name:lang==='en'?'Save assignment':'שמירת השיבוץ',exact:true}).click();
 await expect(dialog).toBeHidden();
 expect(backend.raw.assignments.find(row=>row.day===weekend.friday&&row.publication_id===null)).toMatchObject({
  end_day:weekend.sunday,primary_id:original.primary_id,secondary_id:original.secondary_id,points:1,extra_points:0,title:'',
 });
 expect(backend.calls.filter(call=>call.name==='duty_save_schedule')).toHaveLength(1);
 if(weekend.previous){
  await page.getByRole('button',{name:lang==='en'?'Next month':'חודש הבא',exact:true}).click();
  const adjacent=duty(page,weekend.friday);
  await expect(adjacent).toHaveCount(0);
  await expect(page.locator('.calendar-grid [data-date]').first()).toHaveAttribute('data-date','2026-08-02');
  await expect(dialog).toHaveCount(0);
 }
});

test('duty editor dismisses local edits, keeps nested selects open, restores focus and locks pending saves',async({page,openApp,backend},info)=>{
 await openApp();
 await schedule(page);
 const cell=duty(page,'2026-11-02'),dialog=page.getByRole('dialog',{name:'Edit duty',exact:true});
 for(const dismissal of ['outside','escape','close']){
  await editDuty(page,'2026-11-02');await fits(page,dialog);
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
 await editDuty(page,'2026-11-02');await expect(page.getByRole('combobox',{name:'Primary engineer',exact:true})).toContainText('Alex Atlas');
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve});
 await page.route('**/rest/v1/rpc/duty_save_schedule',async route=>{await gate;await route.fallback()});
 const request=page.waitForRequest('**/rest/v1/rpc/duty_save_schedule');
 await dialog.getByRole('button',{name:'Save assignment',exact:true}).click();await request;
 await expect(dialog.getByRole('button',{name:'Save assignment',exact:true})).toBeDisabled();
 await expect(dialog.getByRole('button',{name:'Lock duty',exact:true})).toBeDisabled();
 await expect(dialog.getByRole('button',{name:'Close',exact:true})).toBeDisabled();
 await page.keyboard.press('Escape');await page.mouse.click(5,5);await expect(dialog).toBeVisible();
 release();await expect(dialog).toBeHidden();
 expect(backend.calls.filter(c=>c.name==='duty_save_schedule')).toHaveLength(1);
 await page.screenshot({path:info.outputPath('duty-dismissed.png')});
});

test('availability fits the screen, supports every dismissal, and discards unsaved notes without writes',async({page,openApp,backend})=>{
 backend.raw.months[0].current_publication_id=null;
 await openApp('a');await page.getByRole('tab',{name:'Availability',exact:true}).click();
 const cell=page.locator('.availability-day[data-gesture-key="2026-11-04"]');
 for(const dismissal of ['outside','escape','close']){
  await cell.click();const dialog=page.getByRole('dialog');await fits(page,dialog);
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
 await openApp();await page.getByRole('tab',{name:'Availability',exact:true}).click();
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
