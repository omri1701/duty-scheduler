import {test, expect, switchLanguage, type Identity} from './fixtures';
import type {Page} from '@playwright/test';
import {calendarMonthLabel} from '../../lib/rota/calendar-dates';

// The schedule opens on the current month in Israel (decision 2026-11-07), for every role, on every
// open, reload or sign-in; navigation after opening stays as is and a `?month=` deep link still wins.
// The fixtures' clock is 9 October 2026, so the current month is October.
const title = (page: Page) => page.locator('.month-title h2');
/** The heading starts with the month's name (a status chip follows it). */
const named = (month: string, lang: 'en' | 'he' = 'en') => new RegExp(`^${calendarMonthLabel(month, lang)}`);
async function schedule(page: Page, he = false) {
  await page.getByRole('tab', {name: he ? 'לוח' : 'Schedule', exact: true}).click();
  await expect(page.locator('.month-bar')).toBeVisible();
}

for (const identity of ['admin', 'a'] as Identity[]) test(`the schedule opens on the current month, also after navigating and reloading (${identity})`, async ({page, openApp}) => {
  await openApp(identity, page, {month: null});
  await schedule(page);
  await expect(title(page)).toHaveText(named('2026-10', 'en'));
  await page.getByRole('button', {name: 'Next month', exact: true}).click();
  await expect(title(page)).toHaveText(named('2026-11', 'en'));
  // Navigation stays where it was taken; a reload opens the current month again, not the last one viewed.
  await page.reload();
  await schedule(page);
  await expect(title(page)).toHaveText(named('2026-10', 'en'));
});

test('the current month follows the Israel date, in Hebrew too', async ({page, openApp}) => {
  await openApp('admin', page, {month: null});
  // 31 October 22:30 UTC is already 1 November in Israel.
  await page.clock.setFixedTime(new Date('2026-10-31T22:30:00Z'));
  await page.reload();
  await switchLanguage(page, 'he');
  await schedule(page, true);
  await expect(title(page)).toHaveText(named('2026-11', 'he'));
});

test('a deep link still opens its own month', async ({page, openApp}) => {
  await openApp('admin', page, {month: null});
  await page.goto('/?tab=schedule&month=2026-12');
  await expect(title(page)).toHaveText(named('2026-12', 'en'));
});
