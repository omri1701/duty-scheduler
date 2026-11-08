import {test,expect,ids,duty,drag,openDutySheet,targetReady} from './fixtures';

// Eligibility and date accents must use Israel even on an engineer's foreign browser.
// (The month bar in every manager state is covered by month-bar.spec.ts.)
test.use({timezoneId:'America/Los_Angeles'});

for(const role of ['admin','a'] as const)for(const method of ['tap','drag']) {
  test(`today published request ${role} ${method} after 09:00`,async({page,backend,openApp},info)=>{
    backend.raw.months[0].status='published';
    backend.raw.assignments.find(d=>d.publication_id&&d.day==='2026-11-02')!.primary_id=ids[role];
    await openApp(role);
    await page.getByRole('tab',{name:'Schedule',exact:true}).click();
    await page.clock.setFixedTime(new Date('2026-11-02T12:00:00Z'));
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await expect(page.locator('[aria-current="date"]')).toHaveText('2');
    // Yesterday still opens; its sheet explains why nothing can be done (decision 2026-11-06).
    let sheet=await openDutySheet(page,'2026-11-01');
    await expect(sheet.getByRole('button',{name:'Swap',exact:true})).toBeDisabled();
    await expect(sheet).toContainText('This day has passed');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // Another member's duty: an admin's Edit opens the published editor; nothing is selected for a swap.
    sheet=await openDutySheet(page,'2026-11-03');
    await expect(duty(page,'2026-11-03')).toHaveAttribute('aria-pressed','false');
    if(role==='admin'){await sheet.getByRole('button',{name:'Edit',exact:true}).click();await expect(page.getByRole('dialog',{name:'Edit duty'})).toBeVisible();}
    else await expect(sheet.getByRole('button',{name:'Swap',exact:true})).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    if(method==='tap') {
      sheet=await openDutySheet(page,'2026-11-02');
      if(role==='admin'){await sheet.getByRole('button',{name:'Edit',exact:true}).click();await page.getByRole('button',{name:'Swap with another duty…',exact:true}).click();}
      else await sheet.getByRole('button',{name:'Swap',exact:true}).click();
      await expect(duty(page,'2026-11-02')).toHaveAttribute('aria-pressed','true');
      await targetReady(page,'2026-11-03');
      await duty(page,'2026-11-03').click();
    }
    else await drag(page,info.project.name==='mobile');
    await page.getByRole('button',{name:'Confirm Request',exact:true}).click();
    expect(backend.raw.swapRequests![0]).toMatchObject({requester_id:ids[role],from_day:'2026-11-02',to_day:'2026-11-03',status:'awaiting_engineer',accepted_by:null});
    expect(backend.calls.filter(c=>c.name==='duty_save_schedule')).toHaveLength(0);
  });
}

test('Israel midnight and resume refresh date accent and published eligibility',async({page,backend,openApp})=>{
  backend.raw.months[0].status='published';
  await openApp('a');
  await page.getByRole('tab',{name:'Schedule',exact:true}).click();
  await page.clock.install({time:new Date('2026-11-02T21:59:59Z')});
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(page.locator('[aria-current="date"]')).toHaveText('2');
  const swappable=async(day:string)=>{
    const sheet=await openDutySheet(page,day);
    const enabled=await sheet.getByRole('button',{name:'Swap',exact:true}).isEnabled();
    await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);
    return enabled;
  };
  expect(await swappable('2026-11-02')).toBe(true);
  await page.clock.runFor(1100);
  await expect(page.locator('[aria-current="date"]')).toHaveText('3');
  expect(await swappable('2026-11-02')).toBe(false);
  await page.clock.setFixedTime(new Date('2026-11-07T12:00:00Z'));
  await page.evaluate(()=>window.dispatchEvent(new Event('pageshow')));
  await expect(duty(page,'2026-11-06').locator('[aria-current="date"]')).toHaveText('7');
  await expect(page.locator('[aria-current="date"]')).toHaveCount(1);
  await page.clock.setFixedTime(new Date('2026-11-08T12:00:00Z'));
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.locator('[aria-current="date"]')).toHaveText('8');
});
