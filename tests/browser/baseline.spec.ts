import {test, expect, ids, MONTH, duty, drag} from './fixtures';

test('signed out, OAuth denial, provider configuration and PKCE handoff', async ({page, openApp, backend, baseURL}) => {
  await openApp('signed-out');
  await expect(page.getByRole('heading', {level: 1})).toContainText('duty calendar');
  await page.goto('/?error_description=Synthetic%20OAuth%20denied');
  // Next.js also provides an accessibility route announcer outside the main region.
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('Synthetic OAuth denied');
  await expect(page.getByRole('button', {name: 'Continue with Google'})).toBeEnabled();
  await page.getByRole('button', {name: 'Continue with Google'}).click();
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('Google sign-in is not enabled yet. The manager needs to finish the Google setup in Supabase.');
  backend.googleEnabled = true;
  const secureContext = await page.evaluate(() => window.isSecureContext);
  await page.getByRole('button', {name: 'Continue with Google'}).click();
  await expect(page.getByRole('heading', {name: 'Synthetic OAuth handoff'})).toBeVisible();
  const params = backend.oauthRequests[0].searchParams;
  expect(params.get('provider')).toBe('google');
  expect(params.get('redirect_to')).toBe(new URL('/', baseURL).href);
  // Docker Desktop's HTTP host alias is not a secure context; Supabase uses
  // its existing plain fallback there, and S256 on localhost / HTTPS.
  expect(params.get('code_challenge_method')).toBe(secureContext ? 's256' : 'plain');
  expect(params.get('code_challenge')).toBeTruthy();
});

for (const [identity, heading] of [['pending', 'Waiting for approval'], ['rejected', 'Request declined'], ['inactive', 'Membership inactive']] as const) {
  test(`${identity} account cannot enter workspace`, async ({page, openApp}) => {
    await openApp(identity);
    await expect(page.getByRole('heading', {name: heading})).toBeVisible();
    await expect(page.getByRole('button', {name: 'Check approval'})).toBeVisible();
    await expect(page.getByRole('button', {name: 'Next month'})).toHaveCount(0);
    await page.getByRole('button', {name: 'Sign out', exact: true}).click();
    await expect(page.getByRole('button', {name: 'Continue with Google'})).toBeVisible();
  });
}

test('pending approval refresh and admin membership review', async ({page, openApp, backend}) => {
  await openApp('pending');
  backend.raw.members.find(m => m.id === ids.pending)!.status = 'approved';
  await page.getByRole('button', {name: 'Check approval'}).click();
  await expect(page.getByRole('button', {name: 'Next month'})).toBeVisible();
  // New page retains an independent identity; the backend is shared only inside this test.
  backend.raw.members.find(m => m.id === ids.pending)!.status = 'pending';
  const admin = await page.context().newPage();
  await openApp('admin', admin);
  await admin.getByRole('tab', {name: 'Team & fairness', exact: true}).click();
  await admin.getByRole('button', {name: 'Approve', exact: true}).click();
  await expect(admin.getByText('No pending requests. Teammates appear here after signing in.')).toBeVisible();
  expect(backend.calls.find(c => c.name === 'duty_review_member')?.params).toMatchObject({p_member: ids.pending, p_status: 'approved'});
});

test('calendar navigation, published visibility, weekends, special and emergency cover', async ({page, openApp}) => {
  await openApp('a');
  await expect(page.getByRole('heading', {name: 'November 2026'})).toBeVisible();
  await expect(duty(page, '2026-11-02')).toHaveAccessibleName(/Alex Atlas/);
  await expect(duty(page, '2026-11-02')).toContainText('+ Casey');
  await expect(duty(page, '2026-11-06')).toContainText('WEEKEND');
  await expect(duty(page, '2026-11-07')).toHaveCount(0); // combined Friday–Sunday
  await expect(duty(page, '2026-11-12')).toContainText('Holiday coverage');
  await expect(duty(page, '2026-11-12')).toContainText('+2');
  for (const day of ['2026-11-20', '2026-11-21']) {
    await expect(duty(page, day)).toContainText('Weekend holiday');
    await expect(duty(page, day)).toContainText('+2');
  }
  await expect(page.getByRole('button', {name: 'Publish', exact: true})).toHaveCount(0);
  await expect(page.getByRole('button', {name: 'Versions', exact: true})).toHaveCount(0);
  await page.getByRole('button', {name: 'Next month'}).click();
  await expect(page.getByRole('heading', {name: 'December 2026'})).toBeVisible();
  await page.getByRole('button', {name: 'Previous month'}).click();
  await expect(duty(page, '2026-11-02')).toHaveAccessibleName(/Alex Atlas/);
  await page.getByRole('button', {name: 'My duties', exact: true}).click();
  await expect(duty(page, '2026-11-02')).toHaveAccessibleName(/Request swap/);
});

test('generation starts empty, saves a draft and publishes after review', async ({page, openApp, backend}) => {
  backend.raw.assignments = []; backend.raw.publications = [];
  backend.raw.months[0].current_publication_id = null; backend.raw.months[0].generated = false;
  await openApp();
  await expect(duty(page, '2026-11-02')).toHaveAccessibleName(/Unassigned/);
  expect(backend.calls.filter(c => c.name === 'duty_save_schedule')).toHaveLength(0);
  await expect(page.getByRole('button', {name: 'Publish', exact: true})).toBeDisabled();
  await page.getByRole('button', {name: 'Generate month', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Regenerate', exact: true})).toBeEnabled();
  const save = backend.calls.find(c => c.name === 'duty_save_schedule')!;
  expect(save.params.p_publish).toBeNull();
  expect(backend.raw.assignments.every(d => d.primary_id)).toBe(true);
  expect(backend.raw.assignments.find(d => d.day === '2026-11-04')!.primary_id).not.toBe(ids.a);
  await page.getByRole('button', {name: 'Publish', exact: true}).click();
  await expect(page.getByRole('dialog', {name: 'Ready to publish?'})).toBeVisible();
  await page.getByRole('button', {name: 'Publish schedule', exact: true}).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByRole('button', {name: 'Reopen draft'})).toBeVisible();
  expect(backend.calls.filter(c => c.name === 'duty_save_schedule').at(-1)!.params.p_publish).toBe(MONTH);
});

test('duty editing, availability override, save failure and published draft separation', async ({page, openApp, backend}) => {
  await openApp();
  const original = backend.raw.assignments.find(d => d.day === '2026-11-04' && d.publication_id)!.primary_id;
  await duty(page, '2026-11-04').click();
  await page.getByRole('combobox', {name: 'Primary engineer', exact: true}).click();
  await page.getByRole('option', {name: 'Alex Atlas · unavailable', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Save assignment'})).toBeDisabled();
  await expect(page.getByRole('dialog')).toContainText('Synthetic vacation');
  await page.getByRole('checkbox', {name: 'Approve these exceptions as manager'}).check();
  backend.failNextSave = true;
  await page.getByRole('button', {name: 'Save assignment'}).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByText('Synthetic stale revision. Refresh and try again.', {exact: true}).first()).toBeVisible();
  await page.getByRole('button', {name: 'Save assignment'}).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(duty(page, '2026-11-04')).toHaveAccessibleName(/Alex Atlas/);
  expect(backend.raw.assignments.find(d => d.day === '2026-11-04' && d.publication_id === null)).toMatchObject({primary_id: ids.a, manager_override: true});
  expect(backend.raw.assignments.find(d => d.day === '2026-11-04' && d.publication_id)!.primary_id).toBe(original);
  await page.getByRole('button', {name: 'Published', exact: true}).click();
  await expect(duty(page, '2026-11-04')).not.toHaveAccessibleName(/Alex Atlas/);
  await expect(page.getByRole('button', {name: 'Special block', exact: true})).toBeHidden();
});

test('draft drag review applies primaries while preserving emergency cover', async ({page, openApp}, info) => {
  await openApp();
  await drag(page, info.project.name === 'mobile');
  await expect(page.getByRole('dialog', {name: 'Swap duties'})).toBeVisible();
  await page.getByRole('button', {name: 'Confirm swap', exact: true}).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(duty(page, '2026-11-02')).toHaveAccessibleName(/Blair Birch/);
  await expect(duty(page, '2026-11-03')).toHaveAccessibleName(/Alex Atlas/);
  await expect(duty(page, '2026-11-02')).toContainText('+ Casey');
});

test('engineer availability save, preference and removal before deadline', async ({page, openApp, backend}) => {
  backend.raw.months[0].current_publication_id = null;
  await openApp('a');
  await page.getByRole('tab', {name: 'Availability', exact: true}).click();
  const day = page.getByRole('button', {name: /^5 Nov.*Available/});
  await day.click();
  await page.getByLabel('Description (optional)').fill('Synthetic appointment');
  await page.getByRole('button', {name: 'Save', exact: true}).click();
  await expect(page.getByRole('button', {name: /^5 Nov.*Unavailable.*Synthetic appointment/})).toBeVisible();
  await page.getByRole('button', {name: /^5 Nov.*Unavailable/}).click();
  await page.getByRole('button', {name: 'Prefer duty', exact: true}).click();
  await page.getByRole('button', {name: 'Save', exact: true}).click();
  await expect(page.getByRole('button', {name: /^5 Nov.*Preferred/})).toBeVisible();
  await page.getByRole('button', {name: /^5 Nov.*Preferred/}).click();
  await page.getByRole('button', {name: 'Remove constraint', exact: true}).click();
  await expect(day).toBeVisible();
  expect(backend.calls.filter(c => c.name === 'duty_set_constraints').map(c => c.params.p_kind)).toEqual(['no', 'prefer', 'clear']);
});

test('publication and elapsed deadline close engineer availability', async ({page, openApp, backend}) => {
  backend.raw.months[0].status = 'published';
  await openApp('a');
  await page.getByRole('tab', {name: 'Availability', exact: true}).click();
  await expect(page.getByRole('button', {name: /^5 Nov/})).toBeDisabled();
  backend.raw.months[0].current_publication_id = null;
  backend.raw.months[0].status = 'draft';
  backend.raw.months[0].deadline = '2026-10-08';
  await page.reload();
  await page.getByRole('tab', {name: 'Availability', exact: true}).click();
  await expect(page.getByRole('button', {name: /^5 Nov/})).toBeDisabled();
});

test('version preview, cancelled restore and confirmed restore preserve live publication', async ({page, openApp, backend}) => {
  await openApp();
  const live = backend.raw.months[0].current_publication_id;
  await page.getByRole('button', {name: 'Versions', exact: true}).click();
  await expect(page.getByRole('dialog')).toContainText('v1 · Live');
  await expect(page.getByRole('dialog')).toContainText('Holiday coverage');
  await page.getByRole('button', {name: 'Restore as draft'}).click();
  await page.getByRole('button', {name: 'Cancel', exact: true}).click();
  expect(backend.calls.filter(c => c.name === 'duty_restore_publication')).toHaveLength(0);
  await page.getByRole('button', {name: 'Restore as draft'}).click();
  await page.getByRole('button', {name: 'Confirm', exact: true}).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(backend.raw.months[0]).toMatchObject({status: 'draft', current_publication_id: live});
});

test('English/Hebrew RTL and keyboard dialog focus', async ({page, openApp}) => {
  await openApp();
  await duty(page, '2026-11-02').focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', {name: 'Edit duty'})).toBeVisible();
  await page.keyboard.press('Tab');
  expect(await page.getByRole('dialog').evaluate(dialog => dialog.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.getByRole('button', {name: 'Switch to Hebrew'}).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'he');
  await expect(page.getByRole('heading', {name: 'נובמבר 2026'})).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', {name: 'Switch to English'}).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
});

test('weekend editor saves split owners atomically', async ({page, openApp, backend}) => {
  await openApp();
  await duty(page, '2026-11-06').click();
  await expect(page.getByRole('dialog', {name: 'Edit weekend'})).toBeVisible();
  await page.getByRole('combobox', {name: 'Saturday engineer', exact: true}).click();
  await page.getByRole('option', {name: 'Alex Atlas', exact: true}).click();
  const override = page.getByRole('checkbox', {name: 'Approve these exceptions as manager'});
  if (await override.isVisible()) await override.check();
  await page.getByRole('button', {name: 'Save assignment'}).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(duty(page, '2026-11-07')).toHaveAccessibleName(/Alex Atlas/);
  const save = backend.calls.filter(c => c.name === 'duty_save_schedule');
  expect(save).toHaveLength(1);
  const state = save[0].params.p_state as {duties: {day: string; end_day: string; primary_id: string}[]};
  expect(state.duties.filter(d => ['2026-11-06', '2026-11-07'].includes(d.day))).toHaveLength(2);
  expect(state.duties.find(d => d.day === '2026-11-07')).toMatchObject({end_day: '2026-11-08', primary_id: ids.a});
});

test('history deletion requires confirmation and closes the last live version', async ({page, openApp, backend}) => {
  await openApp();
  await page.getByRole('button', {name: 'Versions', exact: true}).click();
  await page.getByRole('button', {name: 'Delete version', exact: true}).click();
  await expect(page.getByRole('dialog')).toContainText('Delete live v1?');
  await page.getByRole('button', {name: 'Cancel', exact: true}).click();
  expect(backend.calls.filter(c => c.name === 'duty_delete_publication')).toHaveLength(0);
  await page.getByRole('button', {name: 'Delete version', exact: true}).click();
  await page.getByRole('button', {name: 'Confirm', exact: true}).click();
  await expect(page.getByRole('dialog')).toContainText('No published versions yet.');
  expect(backend.calls.filter(c => c.name === 'duty_delete_publication')).toHaveLength(1);
});
