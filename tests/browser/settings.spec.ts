import {test, expect, ids, switchLanguage} from './fixtures';
import {mockPush, pushState, VAPID_PUBLIC_KEY, SYNTHETIC_ENDPOINT} from './push-mock';

// The settings screen (decision 2026-11-06): name, language saved on the member,
// notifications with Push mocked, the Calendar slot and sign-out. The fixture fails any
// test with a browser error or an unexpected RPC.
const settings = (page: import('@playwright/test').Page) => page.getByRole('dialog', {name: /^(Settings|הגדרות)$/});

for (const lang of ['en', 'he'] as const) test(`settings screen sections and language ${lang}`, async ({page, openApp, backend}) => {
  await mockPush(page);
  backend.vapidPublicKey = VAPID_PUBLIC_KEY;
  await openApp();
  if (lang === 'he') await switchLanguage(page, 'he');
  const label = lang === 'en' ? 'Settings' : 'הגדרות';
  await page.getByRole('button', {name: label, exact: true}).click();
  const sheet = settings(page);
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveAttribute('dir', lang === 'he' ? 'rtl' : 'ltr');
  for (const heading of lang === 'en' ? ['Profile', 'Language', 'Notifications', 'Calendar'] : ['פרופיל', 'שפה', 'התראות', 'לוח שנה'])
    await expect(sheet.getByRole('heading', {name: heading, exact: true})).toBeVisible();
  await expect(sheet.locator('[data-settings-section="calendar"]')).toBeVisible();
  await expect(sheet.getByRole('button', {name: lang === 'en' ? 'Sign out' : 'יציאה', exact: true})).toBeEnabled();
  await expect(sheet.getByRole('button', {name: lang === 'en' ? 'Enable notifications' : 'הפעלת התראות'})).toBeEnabled();
  await expect(sheet.getByText(lang === 'en' ? 'iPhone: Add to Home Screen first' : 'אייפון: קודם להוסיף למסך הבית')).toBeVisible();
  // The sheet fits the screen: no sideways scrolling on a phone.
  expect(await sheet.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  // Choosing the other language applies it at once and saves it on the member.
  const other = lang === 'en' ? 'he' : 'en';
  await sheet.getByRole('radio', {name: other === 'he' ? 'עברית' : 'English'}).check();
  await expect(sheet).toHaveAttribute('dir', other === 'he' ? 'rtl' : 'ltr');
  await expect.poll(() => backend.languages.get(ids.admin)).toBe(other);
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(page.locator('html')).toHaveAttribute('lang', other);
});

test('keyboard: open, move through the language radios and close back to the button', async ({page, openApp, backend}) => {
  await openApp();
  const button = page.getByRole('button', {name: 'Settings', exact: true});
  await button.focus();
  await page.keyboard.press('Enter');
  const sheet = settings(page);
  await expect(sheet).toBeVisible();
  // The sheet takes focus, not the name field (which would open a phone's keyboard).
  await expect(sheet).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(sheet.getByRole('textbox', {name: 'Display name'})).toBeFocused();
  await sheet.getByRole('radio', {name: 'English'}).focus();
  await page.keyboard.press('ArrowRight');
  await expect(sheet.getByRole('radio', {name: 'עברית'})).toBeChecked();
  await expect.poll(() => backend.languages.get(ids.admin)).toBe('he');
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(page.getByRole('button', {name: 'הגדרות', exact: true})).toBeFocused();
});

test('the saved language is the default on sign-in and is not saved again', async ({page, openApp, backend}) => {
  backend.raw.members.find(m => m.id === ids.a)!.language = 'he';
  await openApp('a', page, {waitForReady: false});
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('button', {name: 'הגדרות', exact: true})).toBeVisible();
  expect(backend.calls.filter(c => c.name === 'duty_set_language')).toEqual([]);
});

test('enable flow: permission, subscribe, save this device, test and turn off', async ({page, openApp, backend}) => {
  await mockPush(page);
  backend.vapidPublicKey = VAPID_PUBLIC_KEY;
  await openApp('a');
  await page.getByRole('button', {name: 'Settings', exact: true}).click();
  const sheet = settings(page);
  await expect(sheet.getByRole('status').first()).toHaveText('Notifications are off on this device.');
  await sheet.getByRole('button', {name: 'Enable notifications'}).click();
  await expect(sheet.getByText('Notifications are on for this device.')).toBeVisible();
  expect(await pushState(page)).toMatchObject({requested: 1, registered: 1, subscribed: 1, active: true, permission: 'granted'});
  expect(backend.devices).toEqual([{member: ids.a, endpoint: SYNTHETIC_ENDPOINT, p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: Buffer.alloc(16, 7).toString('base64url')}]);
  await expect(sheet.getByText('iPhone: Add to Home Screen first')).toHaveCount(0);
  // No test button (user review): Settings just says notifications are on for this device.
  await expect(sheet.getByRole('button', {name: /Send a test/})).toHaveCount(0);
  expect(backend.calls.some(c => c.name.includes('test'))).toBe(false);
  await sheet.getByRole('button', {name: 'Turn off on this device'}).click();
  await expect(sheet.getByText('Notifications are off on this device.')).toBeVisible();
  expect(backend.devices).toEqual([]);
  expect(await pushState(page)).toMatchObject({unsubscribed: 1, active: false});
});

test('a refused permission is explained, never an error', async ({page, openApp, backend}) => {
  await mockPush(page, {answer: 'denied'});
  backend.vapidPublicKey = VAPID_PUBLIC_KEY;
  await openApp('a');
  await page.getByRole('button', {name: 'Settings', exact: true}).click();
  const sheet = settings(page);
  await sheet.getByRole('button', {name: 'Enable notifications'}).click();
  await expect(sheet.getByRole('alert')).toHaveText('Notifications weren’t allowed. Allow them for Duty in the browser or phone settings, then try again.');
  await expect(sheet.getByText('Notifications are blocked for Duty.', {exact: false})).toBeVisible();
  await expect(sheet.getByRole('button', {name: 'Enable notifications'})).toBeDisabled();
  expect(backend.devices).toEqual([]);
});

for (const [name, setup, reason] of [
  ['iPhone Safari outside the Home Screen', {iphoneSafari: true}, 'On iPhone, notifications work only in Duty from the Home Screen.'],
  ['notifications blocked', {permission: 'denied' as const}, 'Notifications are blocked for Duty.'],
  ['server without VAPID keys', {}, 'Notifications aren’t set up on this server yet.'],
] as const) test(`enable is disabled with a reason: ${name}`, async ({page, openApp, backend}) => {
  await mockPush(page, setup);
  if (name !== 'server without VAPID keys') backend.vapidPublicKey = VAPID_PUBLIC_KEY;
  await openApp('a');
  await page.getByRole('button', {name: 'Settings', exact: true}).click();
  const sheet = settings(page);
  await expect(sheet.getByText(reason, {exact: false})).toBeVisible();
  await expect(sheet.getByRole('button', {name: 'Enable notifications'})).toBeDisabled();
  await expect(sheet.getByText('iPhone: Add to Home Screen first')).toBeVisible();
  // The switches still work: they are the member's, for every device.
  await sheet.getByRole('checkbox', {name: /Swap requests/}).click();
  await expect.poll(() => backend.notificationSettings.get(ids.a)?.swaps).toBe(false);
});

test('switches and reminder-time wheels save for the member; admins also see new members', async ({page, openApp, backend}) => {
  await openApp('a');
  await page.getByRole('button', {name: 'Settings', exact: true}).click();
  let sheet = settings(page);
  await expect(sheet.getByRole('checkbox', {name: /New member waiting/})).toHaveCount(0);
  const evening = sheet.getByRole('button', {name: /^Evening before my duty · time/}), morning = sheet.getByRole('button', {name: /^Morning of my duty · time/});
  await expect(evening).toHaveText('18:00');
  await expect(morning).toHaveText('08:30');
  // Tapping a row opens its wheels under it; only one is open at a time.
  await evening.click();
  await expect(evening).toHaveAttribute('aria-expanded', 'true');
  const wheels = sheet.getByRole('group', {name: 'Evening before my duty · time'});
  await expect(wheels).toHaveAttribute('dir', 'ltr');
  const hour = wheels.getByRole('spinbutton', {name: 'Hour · Evening before my duty'}), minute = wheels.getByRole('spinbutton', {name: 'Minutes · Evening before my duty'});
  await expect(hour).toHaveAttribute('aria-valuenow', '18');
  await expect(minute).toHaveAttribute('aria-valuenow', '0');
  // The wheels offer every hour and only the quarter hours the 15-minute clock keeps.
  await expect(hour.locator('.time-wheel-item')).toHaveCount(24);
  await expect(minute.locator('.time-wheel-item')).toHaveText(['00', '15', '30', '45']);
  // Clicking an item scrolls it to the centre; it saves once the wheel settles, then says so.
  await hour.locator('.time-wheel-item', {hasText: /^20$/}).click();
  await expect.poll(() => backend.notificationSettings.get(ids.a)?.eveningTime).toBe('20:00');
  await expect(sheet.getByRole('status').filter({hasText: 'Saved'})).toBeVisible();
  await expect(evening).toHaveText('20:00');
  await expect(hour).toHaveAttribute('aria-valuenow', '20');
  // Keyboard: Up steps a wheel, End jumps to its last item.
  await minute.focus();
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => backend.notificationSettings.get(ids.a)?.eveningTime).toBe('20:15');
  await page.keyboard.press('End');
  await expect.poll(() => backend.notificationSettings.get(ids.a)?.eveningTime).toBe('20:45');
  // A touch-like flick: native scrolling that snaps to a row.
  await hour.evaluate(el => el.scrollTo({top: 21 * 44 + 10}));
  await expect.poll(() => backend.notificationSettings.get(ids.a)?.eveningTime).toBe('21:45');
  await expect.poll(() => hour.evaluate(el => el.scrollTop)).toBe(21 * 44);
  // A mouse wheel moves it too.
  await hour.hover();
  await page.mouse.wheel(0, 120);
  await expect.poll(() => Number(backend.notificationSettings.get(ids.a)?.eveningTime.slice(0, 2))).toBeGreaterThan(21);
  // Opening another row closes this one; Esc closes the wheels but not the sheet.
  await morning.click();
  await expect(evening).toHaveAttribute('aria-expanded', 'false');
  await expect(sheet.getByRole('group', {name: 'Evening before my duty · time'})).toHaveCount(0);
  await expect(sheet.getByRole('group', {name: 'Morning of my duty · time'})).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet.getByRole('group', {name: 'Morning of my duty · time'})).toHaveCount(0);
  await expect(sheet).toBeVisible();
  await expect(morning).toBeFocused();
  // Tapping the open row again closes it; a switched-off reminder has no time to pick.
  await morning.click();
  await morning.click();
  await expect(morning).toHaveAttribute('aria-expanded', 'false');
  await sheet.getByRole('checkbox', {name: /Morning of my duty/}).click();
  await expect.poll(() => backend.notificationSettings.get(ids.a)?.morning).toBe(false);
  await expect(morning).toBeDisabled();
  // Reopening reads the saved choices back.
  const savedEvening = backend.notificationSettings.get(ids.a)!.eveningTime;
  await page.keyboard.press('Escape');
  await page.getByRole('button', {name: 'Settings', exact: true}).click();
  sheet = settings(page);
  await expect(sheet.getByRole('button', {name: /^Evening before my duty · time/})).toHaveText(savedEvening);
  await expect(sheet.getByRole('checkbox', {name: /Morning of my duty/})).not.toBeChecked();
  expect(backend.calls.filter(c => c.name === 'duty_set_notification_settings').every(c => c.user === ids.a && !('p_revision' in c.params))).toBe(true);
  await page.keyboard.press('Escape');
  // An admin also chooses whether to hear about new sign-ups.
  await openApp('admin');
  await page.getByRole('button', {name: 'Settings', exact: true}).click();
  await settings(page).getByRole('checkbox', {name: /New member waiting/}).click();
  await expect.poll(() => backend.notificationSettings.get(ids.admin)?.members).toBe(false);
});

test('Hebrew wheels stay left to right; a failed save puts the time back and says so', async ({page, openApp, backend}) => {
  await openApp('a');
  await switchLanguage(page, 'he');
  await page.getByRole('button', {name: 'הגדרות', exact: true}).click();
  const sheet = settings(page);
  await expect(sheet).toHaveAttribute('dir', 'rtl');
  const evening = sheet.getByRole('button', {name: /^ערב לפני התורנות · שעה/});
  await evening.click();
  const wheels = sheet.getByRole('group', {name: 'ערב לפני התורנות · שעה'});
  await expect(wheels).toHaveAttribute('dir', 'ltr');
  const hour = wheels.getByRole('spinbutton', {name: 'שעה · ערב לפני התורנות'});
  await expect(wheels.getByRole('spinbutton', {name: 'דקות · ערב לפני התורנות'})).toBeVisible();
  // Hours on the left, minutes on the right, even in Hebrew.
  const [h, m] = await Promise.all([hour.boundingBox(), wheels.getByRole('spinbutton', {name: 'דקות · ערב לפני התורנות'}).boundingBox()]);
  expect(h!.x).toBeLessThan(m!.x);
  backend.failNotificationSettings = 1;
  await hour.focus();
  await page.keyboard.press('ArrowDown');
  await expect(sheet.getByRole('alert')).toContainText('השעה לא נשמרה ולכן חזרה ל־18:00.');
  await expect(evening).toHaveText('18:00');
  await expect(hour).toHaveAttribute('aria-valuenow', '18');
  await expect.poll(() => hour.evaluate(el => el.scrollTop)).toBe(18 * 44);
  expect(backend.notificationSettings.get(ids.a)?.eveningTime ?? '18:00').toBe('18:00');
  // Scrolling back to the saved time is not a new choice: no second save, and the message stays.
  await page.waitForTimeout(1200);
  expect(backend.calls.filter(c => c.name === 'duty_set_notification_settings')).toHaveLength(1);
  await expect(sheet.getByRole('alert')).toContainText('השעה לא נשמרה ולכן חזרה ל־18:00.');
});

test('signing out in settings forgets this device first', async ({page, openApp, backend}) => {
  await mockPush(page, {permission: 'granted', subscribed: true});
  backend.vapidPublicKey = VAPID_PUBLIC_KEY;
  await openApp('a');
  // The open app registers the already-subscribed device for whoever is signed in.
  await expect.poll(() => backend.devices.map(d => d.member)).toEqual([ids.a]);
  await page.getByRole('button', {name: 'Settings', exact: true}).click();
  await settings(page).getByRole('button', {name: 'Sign out', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Continue with Google'})).toBeVisible();
  expect(backend.devices).toEqual([]);
  expect(await pushState(page)).toMatchObject({unsubscribed: 1});
});

test('a notification link opens its tab and month, then leaves a clean address', async ({page, openApp}) => {
  await openApp('a');
  await page.goto('/?tab=availability&month=2026-12');
  await expect(page.getByRole('tab', {name: 'Availability', exact: true})).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', {name: /December 2026/})).toBeVisible();
  await expect.poll(() => new URL(page.url()).search).toBe('');
});
