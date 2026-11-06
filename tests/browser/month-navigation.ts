import {expect,type Page} from '@playwright/test';

// Shared by the transport regressions and the authenticated, unmocked runtime check.
// Schedule, Availability and Team each carry a .month-title (decision 2026-11-06); the Schedule
// panel stays mounted but hidden behind the other tabs, so only the visible title counts.
const visibleTitle=(page:Page)=>page.locator('.app-shell:not(.startup-skeleton) .month-title:visible');
export async function assertMonthNavigation(page: Page) {
  const heading=visibleTitle(page);
  await expect(heading).toBeVisible();
  const buttons=heading.getByRole('button');
  await expect(buttons).toHaveCount(2);
  for(const button of await buttons.all()) {
    await expect(button).toBeEnabled();
    await expect(button).toBeInViewport({ratio:1});
    expect(await button.evaluate(el=>{
      const r=el.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
      return {width:r.width,height:r.height,hit:!!hit&&el.contains(hit)};
    }), 'navigation must have unobstructed 44px targets').toMatchObject({hit:true});
    const r=(await button.boundingBox())!;
    expect(r.width).toBeGreaterThanOrEqual(44);
    expect(r.height).toBeGreaterThanOrEqual(44);
  }
  return heading.locator('h2').innerText();
}

export async function traverseMonths(page:Page, count=24) {
  const start=await assertMonthNavigation(page),labels=[start];
  const title=visibleTitle(page).locator('h2'),buttons=visibleTitle(page).locator('button');
  for(const direction of [1,-1]) for(let i=0;i<count;i++) {
    const before=await title.innerText(),button=direction===1?buttons.last():buttons.first();
    // Recovery must use the visible controls, including keyboard, without reload.
    if(i===0){await button.focus();await button.press(direction===1?'Enter':'Space');}
    else await button.click();
    await expect(title).not.toHaveText(before);
    const label=await assertMonthNavigation(page);
    if(direction===1){expect(labels).not.toContain(label);labels.push(label);}
  }
  await expect(title).toHaveText(start);
  return labels;
}
