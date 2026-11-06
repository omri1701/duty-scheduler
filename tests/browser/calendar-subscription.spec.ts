import {test, expect, ids, NOW} from './fixtures';
import type {Page} from '@playwright/test';

// Personal calendar subscription (decision 2026-11-06), in the settings screen's Calendar
// section. Runs on the desktop and phone projects.
const TEXT = {
  en: {section: 'Subscribe to my calendar', create: 'Create my calendar link', apple: 'Add to Apple Calendar', google: 'Add to Google Calendar',
    copy: 'Copy link', reset: 'Reset link', cancel: 'Cancel', copied: 'Link copied.', link: 'Calendar link', active: /Your calendar link is active/, google_help: /Google Calendar can take a few hours/},
  he: {section: 'הרשמה ללוח השנה שלי', create: 'יצירת קישור ללוח השנה שלי', apple: 'הוספה ליומן Apple', google: 'הוספה ליומן Google',
    copy: 'העתקת הקישור', reset: 'איפוס הקישור', cancel: 'ביטול', copied: 'הקישור הועתק.', link: 'קישור ללוח השנה', active: /הקישור ללוח השנה שלך פעיל/, google_help: /ביומן Google השינויים עשויים להופיע רק אחרי כמה שעות/},
} as const;
const token = (n: number) => n.toString(16).padStart(64, 'c');

async function openSettings(page: Page, lang: 'en' | 'he') {
  if (lang === 'he') await page.getByRole('button', {name: 'Switch to Hebrew', exact: true}).click();
  await page.getByRole('button', {name: lang === 'he' ? 'הגדרות' : 'Settings', exact: true}).click();
  return page.getByRole('dialog');
}

for (const lang of ['en', 'he'] as const) test(`create, copy and reset my calendar link ${lang}`, async ({page, openApp, backend}) => {
  const x = TEXT[lang];
  await openApp('a');
  // Headless Linux has no system clipboard; capture what the page copies instead.
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {configurable: true,
    value: {writeText: async (text: string) => {(window as unknown as {copied: string}).copied = text;}}}));
  const dialog = await openSettings(page, lang);
  const section = dialog.getByRole('region', {name: x.section});
  await expect(section).toBeVisible();
  await expect(section).toContainText(x.google_help);
  await expect(dialog).toHaveAttribute('dir', lang === 'he' ? 'rtl' : 'ltr');
  // Keyboard: the create button is reachable and works with Enter.
  await section.getByRole('button', {name: x.create, exact: true}).focus();
  await page.keyboard.press('Enter');
  const origin = new URL(page.url()).origin, feed = `${origin}/api/calendar/${token(1)}.ics`, webcal = feed.replace(/^https?:/, 'webcal:');
  const apple = section.getByRole('link', {name: x.apple, exact: true});
  await expect(apple).toHaveAttribute('href', webcal);
  const google = section.getByRole('link', {name: x.google, exact: true});
  await expect(google).toHaveAttribute('href', `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}`);
  await expect(google).toHaveAttribute('target', '_blank');
  await expect(google).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(section.getByRole('textbox', {name: x.link})).toHaveValue(feed);
  expect(backend.calendars.get(ids.a)?.language).toBe(lang);
  for (const target of [apple, google, section.getByRole('button', {name: x.copy})]) {
    const box = await target.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  await section.getByRole('button', {name: x.copy, exact: true}).click();
  await expect(page.getByText(x.copied)).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as {copied: string}).copied)).toBe(feed);

  // Reset asks first; Cancel keeps the link and returns focus to Reset.
  const reset = section.getByRole('button', {name: x.reset, exact: true});
  await reset.click();
  const confirm = section.getByRole('group');
  await expect(confirm.getByRole('button', {name: x.cancel, exact: true})).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(confirm).toBeHidden();
  await expect(reset).toBeFocused();
  expect(backend.calendarResets).toBe(1);
  await reset.click();
  await confirm.getByRole('button', {name: x.reset, exact: true}).click();
  await expect(section.getByRole('textbox', {name: x.link})).toHaveValue(`${origin}/api/calendar/${token(2)}.ics`);
  expect(backend.calendarResets).toBe(2);

  // Reopening on this device shows the same link again without a reset.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await page.getByRole('button', {name: lang === 'he' ? 'הגדרות' : 'Settings', exact: true}).click();
  await expect(section.getByRole('textbox', {name: x.link})).toHaveValue(`${origin}/api/calendar/${token(2)}.ics`);
  expect(backend.calendarResets).toBe(2);
});

for (const lang of ['en', 'he'] as const) test(`a link made on another device is offered as a reset ${lang}`, async ({page, openApp, backend}) => {
  const x = TEXT[lang];
  // Made earlier in the other language: opening here moves the feed to this language.
  backend.calendars.set(ids.a, {createdAt: NOW, language: lang === 'en' ? 'he' : 'en'});
  await openApp('a');
  const dialog = await openSettings(page, lang), section = dialog.getByRole('region', {name: x.section});
  await expect(section).toContainText(x.active);
  await expect(section).toContainText(lang === 'en' ? '9 Oct 2026' : '9 באוק׳ 2026');
  await expect(section.getByRole('link')).toHaveCount(0);
  await expect.poll(() => backend.calendars.get(ids.a)?.language).toBe(lang);
  expect(backend.calendarResets).toBe(0);
  await section.getByRole('button', {name: x.reset, exact: true}).click();
  await section.getByRole('group').getByRole('button', {name: x.reset, exact: true}).click();
  await expect(section.getByRole('link', {name: x.apple, exact: true})).toBeVisible();
  expect(backend.calendarResets).toBe(1);
});

test('signing out forgets the link on this device', async ({page, openApp}) => {
  await openApp('a');
  const dialog = await openSettings(page, 'en');
  await dialog.getByRole('button', {name: TEXT.en.create, exact: true}).click();
  await expect(dialog.getByRole('link', {name: TEXT.en.apple})).toBeVisible();
  expect(await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('duty-calendar-link:')).length)).toBe(1);
  // Sign out is in the settings screen (decision 2026-11-06).
  await dialog.getByRole('button', {name: 'Sign out', exact: true}).click();
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('duty-calendar-link:')).length)).toBe(0);
});

test('pending members see no calendar section', async ({page, openApp, backend}) => {
  await openApp('pending', page, {waitForReady: false});
  await expect(page.getByRole('region', {name: TEXT.en.section})).toHaveCount(0);
  expect(backend.calls.filter(c => c.name.startsWith('duty_calendar_'))).toEqual([]);
});
