import {test,expect,ids,MONTH,duty, switchLanguage, monthAction} from './fixtures';
import type {Page} from '@playwright/test';
import {readGenerationContext} from '../../lib/supabase/generation';
import {canonicalDuties} from '../../lib/scheduling/calendar';

// Non-weekend members (decision 2026-11-01): a standing admin setting in Team, a default
// +1 Permanent in Plan the month, never a weekend from Generate, and a locked weekend kept.
const name=(backend:{raw:{members:{id:string;name:string}[]}},id:string)=>backend.raw.members.find(m=>m.id===id)!.name;
// The app opens on Home: the calendar is on Schedule, the member settings in Team's member sheet.
const he=(page:Page)=>page.locator('html').getAttribute('lang').then(l=>l==='he');
const tab=async(page:Page,en:string,hebrew:string)=>page.getByRole('tab',{name:await he(page)?hebrew:en,exact:true}).click();
const openMember=async(page:Page,id:string)=>{await tab(page,'Team','צוות');await page.locator(`.team-row[data-member="${id}"] .team-row-inner`).click();};
// A tap opens the duty sheet (on a phone, the day's details first); its Edit opens the editor.
async function editDuty(page:Page,day:string){
 await tab(page,'Schedule','לוח');await duty(page,day).click();
 const details=page.locator('[data-day-details] .day-duty');
 await expect(page.getByRole('dialog').or(details)).toBeVisible();
 if(await details.isVisible())await details.click();
 await page.getByRole('dialog').getByRole('button',{name:/^(Edit|עריכה)$/}).click();
}
// Plan the month is the month bar's primary until the month is generated, else in the ⋯ menu.
async function clickPlan(page:Page){
 await tab(page,'Schedule','לוח');
 const label=await he(page)?'תכנון החודש':'Plan the month',primary=page.locator('.month-primary');
 await expect(primary).toBeVisible();
 if(await primary.getAttribute('aria-label')===label)await primary.click();else await monthAction(page,label);
}

for(const lang of ['en','he'] as const)test(`admin marks a member as non-weekend in Team ${lang}`,async({page,openApp,backend})=>{
 const he=lang==='he',label=he?'ללא סופי שבוע':'No weekends',chip=he?'ללא סופ״ש':'No weekends';
 await openApp();
 if(he)await switchLanguage(page, 'he');
 await openMember(page,ids.e);
 const row=page.locator(`.team-row[data-member="${ids.e}"]`),toggle=page.getByRole('dialog').getByRole('switch',{name:`${label} ${name(backend,ids.e)}`,exact:true});
 await expect(toggle).toBeVisible();await expect(toggle).not.toBeChecked();
 await expect(row.locator('.team-name')).not.toContainText(chip);
 await toggle.click();
 await expect(toggle).toBeChecked();
 await expect(row.locator('.team-name')).toContainText(chip);
 expect(backend.raw.members.find(m=>m.id===ids.e)!.no_weekends).toBe(true);
 expect(backend.calls.filter(c=>c.name==='duty_set_no_weekends').map(c=>c.params.p_no_weekends)).toEqual([true]);
 // It is a standing setting: it survives a reload, and only another click clears it.
 await page.reload();
 if(he)await switchLanguage(page, 'he');
 await openMember(page,ids.e);
 await expect(toggle).toBeChecked();
 await toggle.click();await expect(toggle).not.toBeChecked();
 expect(backend.raw.members.find(m=>m.id===ids.e)!.no_weekends).toBe(false);
 // The Active switch is a separate control.
 await expect(page.getByRole('dialog').getByRole('switch',{name:`${he?'פעיל':'Active'} ${name(backend,ids.e)}`,exact:true})).toBeChecked();
});

test('engineers see the setting but cannot change it',async({page,openApp,backend})=>{
 backend.raw.members.find(m=>m.id===ids.e)!.no_weekends=true;
 await openApp('b');await tab(page,'Team','צוות');
 const row=page.locator(`.team-row[data-member="${ids.e}"]`);
 await expect(row.locator('.team-name')).toContainText('No weekends');
 await openMember(page,ids.e);
 await expect(page.getByRole('dialog')).toContainText('No weekends');
 await expect(page.getByRole('switch')).toHaveCount(0);
});

async function openPlan(page:import('@playwright/test').Page,backend:import('./fixtures').Backend,openApp:(identity?:'admin')=>Promise<unknown>,lang:'en'|'he'){
 backend.raw.assignments=[];backend.raw.publications=[];
 backend.raw.months[0]={...backend.raw.months[0],current_publication_id:null,status:'draft',generated:false};
 backend.raw.members.find(m=>m.id===ids.e)!.no_weekends=true;
 // A weekend the manager locked to e before the setting: kept, never deleted.
 backend.raw.assignments.push({id:'locked-weekend',publication_id:null,day:'2026-11-06',end_day:'2026-11-08',primary_id:ids.e,secondary_id:null,title:'',extra_points:0,points:1,locked:true,manager_override:false});
 await openApp();
 const he=lang==='he',dialog=page.getByRole('dialog');
 if(he)await switchLanguage(page, 'he');
 await clickPlan(page);
 await expect(dialog.getByRole('button',{name:he?'אישור ושיבוץ':'Confirm & generate',exact:true})).toBeEnabled({timeout:30_000});
 return {dialog,row:dialog.locator(`.plan-row[data-engineer="${ids.e}"]`)};
}

for(const lang of ['en','he'] as const)test(`Plan the month notes the +1 Permanent and a kept locked weekend ${lang}`,async({page,openApp,backend})=>{
 const he=lang==='he',{dialog,row}=await openPlan(page,backend,openApp,lang);
 await expect(row.locator('.allocation-row-note')).toHaveText(he?'ללא סופי שבוע · +1':'No weekends · +1');
 await expect(row.locator('.plan-chip.permanent')).toHaveText(he?'+1 קבוע':'+1 permanent');
 await expect(row.locator('.allocation-row-warning')).toHaveText(he?'סוף שבוע נעול נשמר. אפשר לבטל את הנעילה בלוח כדי לשחרר אותו.':'A locked weekend is kept. Unlock it in the calendar to free it.');
 // The month total is unchanged: the point comes from the others.
 const [configured,total]=(await dialog.locator('.allocation-footer strong').textContent())!.replace(/[^\d./]/g,'').split('/');
 expect(configured).toBe(total);
 // Members who take weekends get no note.
 await expect(dialog.locator('.plan-row .allocation-row-note')).toHaveCount(1);
});

test('the +1 is editable that month, and Generate gives the member no weekend but the locked one',async({page,openApp,backend})=>{
 test.setTimeout(120_000);
 const {dialog,row}=await openPlan(page,backend,openApp,'en'),member=name(backend,ids.e);
 await dialog.getByRole('button',{name:/^Permanent/}).click();
 await row.getByRole('button',{name:`Decrease Permanent · ${member}`,exact:true}).click();
 await expect(row.locator('.allocation-row-note')).toHaveText('No weekends');
 await dialog.getByRole('button',{name:'Undo',exact:true}).click();
 await expect(row.locator('.allocation-row-note')).toHaveText('No weekends · +1');
 await dialog.getByRole('button',{name:'Confirm & generate',exact:true}).click();
 await expect(dialog).toBeHidden({timeout:60_000});
 const context=readGenerationContext(backend.generationEnvelope(MONTH));
 const weekends=canonicalDuties(MONTH,{}).filter(d=>d.weekendId&&context.assignments[d.id]?.primary===ids.e).map(d=>d.id);
 expect(weekends).toEqual(['2026-11-06']);
 expect(context.allocation!.changes[ids.e]).toEqual({temporary:0,permanent:2});
});

for(const lang of ['en','he'] as const)test(`Plan the month says before Generate when one or no members take weekends ${lang}`,async({page,openApp,backend})=>{
 const he=lang==='he',{dialog}=await openPlan(page,backend,openApp,lang);
 await expect(dialog.getByRole('note').filter({hasText:he?'סופי שבוע ריקים':'weekends empty'})).toHaveCount(0);
 const participants=backend.raw.members.filter(m=>m.active&&m.status==='approved');
 for(const takers of [1,0]){
  participants.forEach((m,i)=>{m.no_weekends=i>=takers;});
  await page.reload();
  if(he)await switchLanguage(page, 'he');
  await clickPlan(page);
  await expect(dialog.getByRole('button',{name:he?'אישור ושיבוץ':'Confirm & generate',exact:true})).toBeEnabled({timeout:30_000});
  await expect(dialog.getByRole('note').filter({hasText:takers?(he?'רק חבר אחד כאן עושה סופי שבוע':'Only one member here takes weekends'):(he?'אף אחד כאן לא עושה סופי שבוע':'No one here takes weekends')})).toBeVisible();
 }
});

for(const lang of ['en','he'] as const)test(`Plan the month says when the weekend members cannot fund every +1 ${lang}`,async({page,openApp,backend})=>{
 const he=lang==='he',{dialog}=await openPlan(page,backend,openApp,lang);
 await expect(dialog.getByRole('note').filter({hasText:he?'לא ניתנת':'is left out'})).toHaveCount(0);
 const participants=backend.raw.members.filter(m=>m.active&&m.status==='approved');
 participants.forEach((m,i)=>{m.no_weekends=i>=1;});
 await page.reload();
 if(he)await switchLanguage(page, 'he');
 await clickPlan(page);
 await expect(dialog.getByRole('button',{name:he?'אישור ושיבוץ':'Confirm & generate',exact:true})).toBeEnabled({timeout:30_000});
 const taker=participants[0].name,left=await dialog.locator('.allocation-row-note').filter({hasText:new RegExp(`^${he?'ללא סופי שבוע':'No weekends'}$`)}).count();
 expect(left).toBeGreaterThan(1);
 await expect(dialog.getByRole('note').filter({hasText:he?`רק ${taker} עושה סופי שבוע, ולכן התוספת של „ללא סופי שבוע” לא ניתנת ל־${left} חברים החודש.`:
  `Only ${taker} takes weekends, so the No weekends +1 is left out for ${left} members this month.`})).toBeVisible();
 // No one is cut to fund it: every non-weekend row stays without a minus.
 await expect(dialog.locator('.allocation-row-note').filter({hasText:/−|-\d/})).toHaveCount(0);
});

// Reset (decision 2026-11-05): the plan a first opening makes, so the automatic +1s follow the
// current settings; re-plan still keeps hand edits. It asks only when it would discard them.
for(const lang of ['en','he'] as const)test(`Reset in Plan the month returns to the starting plan ${lang}`,async({page,openApp,backend})=>{
 const he=lang==='he',{dialog,row}=await openPlan(page,backend,openApp,lang),who=name(backend,ids.e);
 const reset=dialog.getByRole('button',{name:he?'איפוס':'Reset',exact:true}),note=row.locator('.allocation-row-note');
 const status=dialog.locator('.plan-reset-note'),ask=dialog.getByRole('group',{name:he?'איפוס התוכנית':'Reset the plan'});
 await expect(note).toHaveText(he?'ללא סופי שבוע · +1':'No weekends · +1');
 // Nothing to reset yet: disabled, and pressing it says why.
 await expect(reset).toHaveAttribute('aria-disabled','true');
 await expect(reset).toHaveAccessibleDescription(he?'זו כבר התוכנית ההתחלתית.':'This is already the starting plan.');
 // Still pressable (aria-disabled), so a phone can show the reason too.
 await reset.click({force:true});
 await expect(status).toHaveText(he?'זו כבר התוכנית ההתחלתית.':'This is already the starting plan.');
 // Fits beside Undo on a phone as on a desktop.
 const box=(await reset.boundingBox())!;expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
 // A hand edit: the +1 taken back.
 await dialog.getByRole('button',{name:he?/^קבוע/:/^Permanent/}).click();
 await row.getByRole('button',{name:`${he?'הפחתת קבוע':'Decrease Permanent'} · ${who}`,exact:true}).click();
 await expect(note).toHaveText(he?'ללא סופי שבוע':'No weekends');
 await expect(status).toHaveCount(0);
 await expect(reset).toHaveAttribute('aria-disabled','false');
 // It would discard the edit, so it asks; keeping the changes leaves the plan as it is.
 await reset.click();
 await expect(ask).toContainText(he?'האיפוס מבטל את השינויים הידניים והגרירות ומתחיל מהתוכנית האוטומטית.':'Reset discards your hand edits and drags and starts from the automatic plan.');
 await ask.getByRole('button',{name:he?'להשאיר את השינויים':'Keep changes',exact:true}).click();
 await expect(ask).toHaveCount(0);
 await expect(note).toHaveText(he?'ללא סופי שבוע':'No weekends');
 await reset.click();
 await ask.getByRole('button',{name:he?'איפוס':'Reset',exact:true}).click();
 await expect(note).toHaveText(he?'ללא סופי שבוע · +1':'No weekends · +1');
 await expect(dialog.getByRole('status').filter({hasText:he?'התוכנית אופסה להצעה ההתחלתית.':'Plan reset to the starting proposal.'})).toBeVisible();
 await expect(reset).toHaveAttribute('aria-disabled','true');
 await expect(dialog.getByRole('button',{name:he?'אישור ושיבוץ':'Confirm & generate',exact:true})).toBeEnabled();
 // Undo brings the edit back.
 await dialog.getByRole('button',{name:he?'ביטול שינוי':'Undo',exact:true}).click();
 await expect(note).toHaveText(he?'ללא סופי שבוע':'No weekends');
});

// Clearing a weekend (reported 2026-11-05): Leave unassigned keeps one empty weekend, never two halves.
for(const lang of ['en','he'] as const)test(`clearing a weekend in the editor keeps it one weekend ${lang}`,async({page,openApp,backend})=>{
 const he=lang==='he';
 await openApp();
 if(he)await switchLanguage(page, 'he');
 await editDuty(page,'2026-11-06');
 const dialog=page.getByRole('dialog');
 await dialog.getByRole('combobox',{name:he?'מהנדס ראשי ביום שישי':'Friday primary engineer',exact:true}).click();
 await page.getByRole('option',{name:he?'ללא שיבוץ':'Leave unassigned',exact:true}).click();
 await expect(dialog.getByRole('combobox',{name:he?'מהנדס ביום שבת':'Saturday engineer',exact:true})).toHaveText(he?'ללא שיבוץ':'Leave unassigned');
 await dialog.getByRole('button',{name:he?'שמירת השיבוץ':'Save assignment',exact:true}).click();
 await expect(dialog).toBeHidden();
 const save=backend.calls.filter(c=>c.name==='duty_save_schedule').at(-1)!.params.p_state as {duties:{day:string;end_day:string;primary_id:string|null}[]};
 expect(save.duties.filter(d=>['2026-11-06','2026-11-07'].includes(d.day))).toEqual([expect.objectContaining({day:'2026-11-06',end_day:'2026-11-08',primary_id:null})]);
 await expect(duty(page,'2026-11-07')).toHaveCount(0);
});

// No weekends (decision 2026-11-05): placing such a member on a weekend by hand warns and needs
// the manager's approval, like an availability conflict.
for(const lang of ['en','he'] as const)test(`placing a No weekends member on a weekend asks for approval ${lang}`,async({page,openApp,backend})=>{
 const he=lang==='he',who=name(backend,ids.e);
 backend.raw.members.find(m=>m.id===ids.e)!.no_weekends=true;
 // The weekend starts with someone else, so the member is newly placed.
 backend.raw.assignments.filter(r=>r.day==='2026-11-06').forEach(r=>{r.primary_id=ids.a;});
 await openApp();
 if(he)await switchLanguage(page, 'he');
 await editDuty(page,'2026-11-06');
 const dialog=page.getByRole('dialog'),save=dialog.getByRole('button',{name:he?'שמירת השיבוץ':'Save assignment',exact:true});
 await dialog.getByRole('combobox',{name:he?'מהנדס ראשי ביום שישי':'Friday primary engineer',exact:true}).click();
 const option=page.getByRole('option',{name:new RegExp(`^${who}`)});
 await expect(option).toContainText(he?' · ללא סופי שבוע':' · no weekends');
 await option.click();
 // Saturday follows Friday: both days are named.
 const warning=dialog.locator('.warning-note');
 await expect(warning).toContainText(he?`${who} לא עושה סופי שבוע`:`${who} doesn’t take weekends`);
 await expect(warning.locator('p').filter({hasText:he?'לא עושה סופי שבוע':'doesn’t take weekends'})).toHaveCount(2);
 await expect(save).toBeDisabled();
 await dialog.getByRole('checkbox',{name:he?'אישור החריגות כמנהל':'Approve these exceptions as manager'}).check();
 await save.click();
 await expect(dialog).toBeHidden();
 const state=backend.calls.filter(c=>c.name==='duty_save_schedule').at(-1)!.params.p_state as {duties:{day:string;end_day:string;primary_id:string|null;manager_override:boolean}[]};
 expect(state.duties.find(d=>d.day==='2026-11-06')).toMatchObject({end_day:'2026-11-08',primary_id:ids.e,manager_override:true});
 // Reopening the same weekend asks nothing more: they are already there.
 await editDuty(page,'2026-11-06');
 await expect(dialog.locator('.warning-note')).toHaveCount(0);
 await expect(save).toBeEnabled();
});

for(const lang of ['en','he'] as const)test(`a published weekend edit to a No weekends member needs approval ${lang}`,async({page,openApp,backend})=>{
 const he=lang==='he',who=name(backend,ids.e);
 backend.raw.months[0].status='published';
 backend.raw.members.find(m=>m.id===ids.e)!.no_weekends=true;
 // The weekend starts with someone else, so the member is newly placed.
 backend.raw.assignments.filter(r=>r.day==='2026-11-06').forEach(r=>{r.primary_id=ids.a;});
 await openApp();
 if(he)await switchLanguage(page, 'he');
 await editDuty(page,'2026-11-06');
 const dialog=page.getByRole('dialog'),review=dialog.getByRole('button',{name:he?'בדיקת השינוי':'Review change',exact:true});
 await dialog.getByRole('combobox',{name:he?'מהנדס':'Engineer',exact:true}).click();
 await page.getByRole('option',{name:new RegExp(`^${who}`)}).click();
 await expect(dialog.getByRole('alert')).toContainText(he?`${who} לא עושה סופי שבוע`:`${who} doesn’t take weekends`);
 await expect(review).toBeDisabled();
 await dialog.getByRole('checkbox',{name:he?'אישור החריגה כמנהל':'Approve this exception as manager'}).check();
 await expect(review).toBeEnabled();
});
