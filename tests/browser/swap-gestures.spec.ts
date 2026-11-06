import type {Page} from '@playwright/test';
import {test, expect, ids, duty, touchEvent, openDutySheet} from './fixtures';

// Published swaps by hold-and-drag and by tap (owner review 2026-11-07): the very first drag works
// while the target's availability is still being read, and a selected duty deselects on a second
// tap or Escape.
const schedule = (page: Page) => page.getByRole('tab', {name: 'Schedule', exact: true}).click();
function hold() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => {release = resolve;});
  return {wait, release};
}
/** Hold, move onto the target and drop at once, without waiting for its availability. */
async function quickDrag(page: Page, touch: boolean, from: string, to: string) {
  const a = (await duty(page, from).boundingBox())!, b = (await duty(page, to).boundingBox())!;
  const x = a.x + a.width / 2, y = a.y + a.height / 2, tx = b.x + b.width / 2, ty = b.y + b.height / 2;
  if (touch) {
    await touchEvent(page, 'touchstart', x, y); await page.waitForTimeout(400);
    await touchEvent(page, 'touchmove', tx, ty);
    await expect(duty(page, to)).toHaveClass(/drag-target/);
    await touchEvent(page, 'touchend', tx, ty);
  } else {
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 8, y, {steps: 2});
    await page.mouse.move(tx, ty, {steps: 8});
    // The target is taken while it is checked: highlighted, not refused.
    await expect(duty(page, to)).toHaveClass(/drag-target/);
    await page.mouse.up();
  }
}

test('the first published drag completes once the target availability arrives', async ({page, openApp, backend}, info) => {
  backend.raw.months[0].status = 'published';
  const gate = hold(); backend.availabilityGate = gate.wait;
  await openApp('a'); await schedule(page);
  await quickDrag(page, info.project.name === 'mobile', '2026-11-02', '2026-11-03');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  gate.release();
  await expect(page.getByRole('dialog', {name: 'Ask to swap'})).toBeVisible();
  await page.getByRole('button', {name: 'Confirm Request', exact: true}).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(backend.raw.swapRequests![0]).toMatchObject({requester_id: ids.a, from_day: '2026-11-02', to_day: '2026-11-03', status: 'awaiting_engineer'});
  expect(backend.calls.filter(c => c.name === 'duty_save_schedule')).toHaveLength(0);
});

test('a first drop on a target the server refuses explains why and opens nothing', async ({page, openApp, backend}, info) => {
  backend.raw.months[0].status = 'published';
  backend.raw.constraints.push({member_id: ids.a, day: '2026-11-03', kind: 'no', note: ''});
  const gate = hold(); backend.availabilityGate = gate.wait;
  await openApp('a'); await schedule(page);
  await quickDrag(page, info.project.name === 'mobile', '2026-11-02', '2026-11-03');
  gate.release();
  await expect(page.locator('[data-sonner-toast]').filter({hasText: 'You can’t take 3 Nov'})).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(backend.calls.filter(c => c.name === 'duty_request_swap')).toHaveLength(0);
});

test('a selected duty is clearly marked and deselects on a second tap or Escape', async ({page, openApp, backend}) => {
  backend.raw.months[0].status = 'published';
  await openApp('a');
  const cell = duty(page, '2026-11-02');
  for (const how of ['tap', 'Escape'] as const) {
    await (await openDutySheet(page, '2026-11-02')).getByRole('button', {name: 'Swap', exact: true}).click();
    await expect(cell).toHaveAttribute('aria-pressed', 'true');
    await expect(cell).toHaveClass(/drag-source/);
    // A strong selected state: a solid brand ring, not a faint tint.
    expect(await cell.evaluate(el => getComputedStyle(el).boxShadow)).toMatch(/3px/);
    if (how === 'tap') await cell.click();
    else {await page.locator('.month-title:visible h2').click(); await page.keyboard.press('Escape');}
    await expect(cell).toHaveAttribute('aria-pressed', 'false');
    await expect(cell).not.toHaveClass(/drag-source/);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  expect(backend.calls.filter(c => c.name === 'duty_request_swap')).toHaveLength(0);
});
