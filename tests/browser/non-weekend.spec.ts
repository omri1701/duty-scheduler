import {test,expect,ids,MONTH} from './fixtures';
import {readGenerationContext} from '../../lib/supabase/generation';
import {canonicalDuties} from '../../lib/scheduling/calendar';

// Non-weekend members (decision 2026-11-01): a standing admin setting in Team, a default
// +1 Permanent in Plan the month, never a weekend from Generate, and a locked weekend kept.
const name=(backend:{raw:{members:{id:string;name:string}[]}},id:string)=>backend.raw.members.find(m=>m.id===id)!.name;

for(const lang of ['en','he'] as const)test(`admin marks a member as non-weekend in Team ${lang}`,async({page,openApp,backend})=>{
 const he=lang==='he',label=he?'ללא סופי שבוע':'No weekends';
 await openApp();
 if(he)await page.getByRole('button',{name:'Switch to Hebrew',exact:true}).click();
 await page.getByRole('tab').nth(2).click();
 const row=page.locator(`.gesture-grid [data-gesture-key="${ids.e}"]`),toggle=row.getByRole('checkbox',{name:`${label} ${name(backend,ids.e)}`,exact:true});
 await expect(toggle).toBeVisible();await expect(toggle).not.toBeChecked();
 await expect(row.locator('.team-name small')).not.toContainText(label);
 await toggle.click();
 await expect(toggle).toBeChecked();
 await expect(row.locator('.team-name small')).toContainText(label);
 expect(backend.raw.members.find(m=>m.id===ids.e)!.no_weekends).toBe(true);
 expect(backend.calls.filter(c=>c.name==='duty_set_no_weekends').map(c=>c.params.p_no_weekends)).toEqual([true]);
 // It is a standing setting: it survives a reload, and only another click clears it.
 await page.reload();
 if(he)await page.getByRole('button',{name:'Switch to Hebrew',exact:true}).click();
 await page.getByRole('tab').nth(2).click();
 await expect(toggle).toBeChecked();
 await toggle.click();await expect(toggle).not.toBeChecked();
 expect(backend.raw.members.find(m=>m.id===ids.e)!.no_weekends).toBe(false);
 // The Active checkbox is a separate control.
 await expect(row.locator('.active-checkbox').getByRole('checkbox')).toBeChecked();
});

test('engineers see the setting but cannot change it',async({page,openApp,backend})=>{
 backend.raw.members.find(m=>m.id===ids.e)!.no_weekends=true;
 await openApp('b');await page.getByRole('tab').nth(2).click();
 const row=page.locator(`.gesture-grid [data-gesture-key="${ids.e}"]`);
 await expect(row.locator('.team-name small')).toContainText('No weekends');
 await expect(row.locator('.weekend-checkbox')).toBeHidden();
});

async function openPlan(page:import('@playwright/test').Page,backend:import('./fixtures').Backend,openApp:(identity?:'admin')=>Promise<unknown>,lang:'en'|'he'){
 backend.raw.assignments=[];backend.raw.publications=[];
 backend.raw.months[0]={...backend.raw.months[0],current_publication_id:null,status:'draft',generated:false};
 backend.raw.members.find(m=>m.id===ids.e)!.no_weekends=true;
 // A weekend the manager locked to e before the setting: kept, never deleted.
 backend.raw.assignments.push({id:'locked-weekend',publication_id:null,day:'2026-11-06',end_day:'2026-11-08',primary_id:ids.e,secondary_id:null,title:'',extra_points:0,points:1,locked:true,manager_override:false});
 await openApp();
 const he=lang==='he',dialog=page.getByRole('dialog');
 if(he)await page.getByRole('button',{name:'Switch to Hebrew',exact:true}).click();
 await page.getByRole('button',{name:he?'יצירת שיבוץ':'Generate month',exact:true}).click();
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
