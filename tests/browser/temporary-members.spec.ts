import {test,expect,ids,MONTH,duty} from './fixtures';
import {validateGeneration} from '../../lib/scheduling/validate';
import {readGenerationContext} from '../../lib/supabase/generation';

test('admin creates 12 temporary engineers, edits constraints/order/status and saves/reloads real November generation',async({page,backend,openApp})=>{
 test.setTimeout(120_000);
 const history=structuredClone(backend.raw.assignments.filter(a=>a.publication_id));
 backend.raw.assignments=structuredClone(history);
 backend.raw.months[0].generated=false;
 await openApp();await page.getByRole('tab',{name:'Team & fairness',exact:true}).click();
 for(let i=1;i<=12;i++){
  await page.getByRole('button',{name:'Add Temporary Member',exact:true}).click();
  const dialog=page.getByRole('dialog');
  await expect(dialog.getByRole('textbox')).toHaveCount(1);
  await expect(dialog.getByRole('button',{name:'Add member',exact:true})).toBeDisabled();
  await dialog.getByLabel('Name',{exact:true}).fill(`Temporary Engineer ${i}`);
  await dialog.getByRole('button',{name:'Add member',exact:true}).click();
  await expect(dialog).toBeHidden();
 }
 const members=backend.raw.members.filter(m=>m.is_temporary),first=members[0];
 expect(members).toHaveLength(12);expect(members.every(m=>m.email===null&&m.active)).toBe(true);
 const firstRow=page.locator(`[data-gesture-key="${first.id}"]`);
 await expect(firstRow.getByText('Temporary',{exact:true})).toBeVisible();
 await expect(firstRow.getByRole('combobox')).toBeDisabled();
 await firstRow.getByRole('button',{name:`Edit name ${first.name}`,exact:true}).click();
 await page.getByRole('dialog').getByLabel('Name',{exact:true}).fill('Renamed Engineer');
 await page.getByRole('button',{name:'Save name',exact:true}).click();
 await expect(firstRow.getByText('Renamed Engineer',{exact:true})).toBeVisible();
 await firstRow.locator('.team-grip').focus();await page.keyboard.press('ArrowUp');
 await expect(firstRow.locator('.team-grip')).toBeFocused();
 expect(backend.raw.members.find(m=>m.id===first.id)!.seniority).toBeLessThan(7);
 for(const id of [ids.a,ids.b,ids.c,ids.d,ids.e]){
  const row=page.locator(`[data-gesture-key="${id}"]`);
  await row.getByRole('checkbox').click();await expect(row.getByRole('checkbox')).not.toBeChecked();
 }
 // Deactivate/reactivate a temporary member without replacing its identity.
 await firstRow.getByRole('checkbox').click();await expect(firstRow).toHaveClass(/inactive/);
 await firstRow.getByRole('checkbox').click();await expect(firstRow).not.toHaveClass(/inactive/);
 await page.getByRole('tab',{name:'Availability',exact:true}).click();
 await page.getByRole('combobox',{name:'Engineer',exact:true}).click();
 await page.getByRole('option',{name:'Renamed Engineer',exact:true}).click();
 await page.getByRole('button',{name:/^5 Nov.*Available/}).click();
 await page.getByLabel('Description (optional)').fill('Private temporary absence');
 await page.getByRole('button',{name:'Save',exact:true}).click();
 await expect(page.getByRole('button',{name:/^5 Nov.*Unavailable.*Private temporary absence/})).toBeVisible();
 await page.getByRole('tab').first().click();
 await page.getByRole('button',{name:'Generate month',exact:true}).click();
 await expect(page.getByRole('button',{name:'Confirm & generate',exact:true})).toBeEnabled({timeout:30_000});
 await expect(page.locator('.plan-row')).toHaveCount(13);
 await page.getByRole('button',{name:'Confirm & generate',exact:true}).click();
 await expect(page.getByRole('dialog')).toBeHidden({timeout:45_000});
 const context=readGenerationContext(backend.generationEnvelope(MONTH));
 const metrics=validateGeneration(context.generationInput!,context.assignments);
 expect(metrics.deficits.every(n=>n===0)).toBe(true);
 expect(members.every(m=>Object.values(context.assignments).some(a=>a.primary===m.id))).toBe(true);
 expect(context.assignments['2026-11-05'].primary).not.toBe(first.id);
 expect(Object.values(context.assignments).every(a=>![ids.a,ids.b,ids.c,ids.d,ids.e].includes(a.primary!))).toBe(true);
 expect(backend.raw.assignments.filter(a=>a.publication_id)).toEqual(history);
 const saved=structuredClone(backend.raw.assignments);
 await page.reload();await expect(page.locator('.workspace-controls')).toBeEnabled();
 expect(backend.raw.assignments).toEqual(saved);
 await expect(duty(page,'2026-11-05')).not.toHaveAccessibleName(/Renamed Engineer/);
 await page.getByRole('tab',{name:'Team & fairness',exact:true}).click();
 await expect(page.locator(`[data-gesture-key="${first.id}"]`).getByText('Renamed Engineer',{exact:true})).toBeVisible();
});

test('temporary member controls are absent for engineers',async({page,backend,openApp})=>{
 backend.raw.members.push({...backend.raw.members[1],id:'22000000-0000-4000-8000-000000000001',email:null,is_temporary:true,name:'Temporary colleague'});
 await openApp('a');await page.getByRole('tab',{name:'Team & fairness',exact:true}).click();
 await expect(page.getByText('Temporary',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Add Temporary Member',exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:/Edit name/})).toHaveCount(0);
});

test('Hebrew temporary member dialog supports keyboard, validation and retry at 320px',async({page,backend,openApp},info)=>{
 await page.setViewportSize({width:320,height:812});await openApp();
 await page.getByRole('button',{name:'Switch to Hebrew'}).click();
 await page.getByRole('tab').nth(2).click();
 await page.getByRole('button',{name:'הוספת חבר זמני',exact:true}).click();
 const dialog=page.getByRole('dialog');await expect(dialog).toHaveAttribute('dir','rtl');
 const input=dialog.getByLabel('שם',{exact:true});await expect(input).toBeFocused();
 await input.fill('   ');await expect(dialog.getByRole('button',{name:'הוספת חבר',exact:true})).toBeDisabled();
 await input.fill('מהנדס זמני');backend.failNextSave=true;await input.press('Enter');
 await expect(dialog.getByRole('alert')).toHaveText(/הלוח השתנה בכרטיסייה אחרת/);
 await expect(input).toHaveValue('מהנדס זמני');await input.press('Enter');await expect(dialog).toBeHidden();
 const row=page.locator('.team-row').last();await expect(row.getByText('זמני',{exact:true})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await info.attach('temporary-members-he-320.png',{body:await page.screenshot({fullPage:true}),contentType:'image/png'});
});
