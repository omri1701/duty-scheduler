import {test, expect, ids, MONTH, switchLanguage} from './fixtures';

function gate() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => {release = resolve;});
  return {wait, release};
}
// The signed-in workspace (decision 2026-11-06) opens on Home; its avatar button is the private mark.
const PRIVATE = '.app-shell:not(.startup-skeleton) .home,.admin-avatar';

async function watchPrivateMounts(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    Object.assign(window, {privateMounts: 0,accessMounts:0});
    new MutationObserver(() => {
      if (document.querySelector('.app-shell:not(.startup-skeleton) .home,.admin-avatar')) (window as unknown as {privateMounts:number}).privateMounts++;
      if (document.querySelector('.access-card')) (window as unknown as {accessMounts:number}).accessMounts++;
    }).observe(document, {childList:true,subtree:true});
  });
}

for (const phase of ['config', 'auth', 'snapshot'] as const) {
  test(`public shell while ${phase} is slow, then immediate verified home`, async ({page,openApp,backend}, info) => {
    const held=gate();
    if (phase==='config') backend.configGate=held.wait;
    if (phase==='auth') backend.authGate=held.wait;
    if (phase==='snapshot') backend.loadGate=held.wait;
    const requests:string[]=[];
    page.on('request',request=>{const path=new URL(request.url()).pathname;if(['/api/config','/auth/v1/user','/rest/v1/rpc/duty_load','/rest/v1/rpc/duty_generation_context'].includes(path))requests.push(path);});
    await watchPrivateMounts(page);
    await openApp('admin',page,{waitForReady:false});
    const shell=page.locator('.startup-skeleton');
    try {
      await expect(shell).toBeVisible();
      await expect(shell).toHaveAttribute('aria-busy','true');
      await expect(shell.getByRole('status')).toHaveText('Loading…');
      await expect(shell.locator('[inert][aria-hidden=true]')).toHaveCount(1);
      await expect(shell.locator('button:not(:disabled),a,input,[tabindex]:not([tabindex="-1"])')).toHaveCount(0);
      await expect(shell).not.toContainText(/Avery|Atlas|Synthetic vacation|Holiday coverage|example.invalid/);
      await expect(page.locator(PRIVATE)).toHaveCount(0);
      expect(await page.evaluate(()=>(window as unknown as {privateMounts:number}).privateMounts)).toBe(0);
      expect(backend.calls.filter(c=>c.name==='duty_generation_context')).toHaveLength(0);
      await page.keyboard.press('Tab');
      expect(await shell.evaluate(node=>node.contains(document.activeElement))).toBe(false);
      // The shell reserves the header and the tab bar at their final sizes: nothing shifts when Home arrives.
      const before=await page.locator('.hdr').boundingBox();
      const navBefore=info.project.name==='mobile'?await page.locator('.tabbar').boundingBox():null;
      if (phase==='auth') await info.attach('startup-shell',{body:await page.screenshot(),contentType:'image/png'});
      held.release();
      await expect(page.getByRole('button',{name:'Settings'})).toBeVisible();
      await expect(shell).toHaveCount(0);
      expect(await page.evaluate(()=>(window as unknown as {accessMounts:number}).accessMounts)).toBe(0);
      expect(await page.locator('.hdr').boundingBox()).toEqual(before);
      if (info.project.name==='mobile') expect(await page.locator('.tabbar').boundingBox()).toEqual(navBefore);
      // The verified manager reads allocation/cutoff facts after bootstrap; Home's balance is a read too.
      await expect.poll(()=>backend.calls.map(c=>c.name).filter(n=>n!=='duty_balance')).toEqual(['duty_load','duty_generation_context']);
      expect(backend.calls.find(c=>c.name==='duty_generation_context')).toMatchObject({user:ids.admin,params:{p_month:MONTH,p_revision:backend.raw.revision}});
      expect(requests.sort()).toEqual(['/api/config','/auth/v1/user','/rest/v1/rpc/duty_generation_context','/rest/v1/rpc/duty_load']);
    } finally {held.release();}
  });
}

test('fast approved restoration skips the access card and removes the shell',async({page,openApp})=>{
  await watchPrivateMounts(page);
  await openApp();
  await expect(page.locator('.startup-skeleton')).toHaveCount(0);
  expect(await page.evaluate(()=>(window as unknown as {accessMounts:number}).accessMounts)).toBe(0);
});

test('failed verification discards an already returned private snapshot without flashing it', async ({page,openApp,backend}) => {
  const held=gate();backend.authGate=held.wait;backend.authFailure=true;
  await watchPrivateMounts(page);
  const loaded=page.waitForResponse('**/rest/v1/rpc/duty_load');
  await openApp('admin',page,{waitForReady:false});
  try {
    await loaded;
    await expect(page.locator('.startup-skeleton')).toBeVisible();
  } finally {held.release();}
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('Synthetic session expired');
  await expect(page.getByRole('button',{name:'Continue with Google'})).toBeVisible();
  await expect(page.locator('.startup-skeleton,.app-shell .home,.admin-avatar')).toHaveCount(0);
  expect(await page.evaluate(()=>(window as unknown as {privateMounts:number}).privateMounts)).toBe(0);
  expect(backend.calls.map(c=>c.name)).toEqual(['duty_load']);
});

test('Google PKCE return keeps the public shell until verification succeeds',async({page,openApp,backend})=>{
  const held=gate();backend.googleEnabled=true;backend.authGate=held.wait;
  await watchPrivateMounts(page);
  const exchange=page.waitForRequest('**/auth/v1/token?grant_type=pkce');
  await openApp('signed-out',page,{waitForReady:false,oauthReturn:true});
  try {
    expect((await exchange).postDataJSON()).toMatchObject({auth_code:'synthetic-oauth-code',code_verifier:'synthetic-verifier'});
    await expect(page.locator('.startup-skeleton')).toBeVisible();
    await expect(page.locator(PRIVATE)).toHaveCount(0);
    expect(await page.evaluate(()=>(window as unknown as {accessMounts:number}).accessMounts)).toBe(0);
  } finally {held.release();}
  await expect(page.getByRole('button',{name:'Settings'})).toBeVisible();
  await expect(page.locator('.startup-skeleton')).toHaveCount(0);
  expect(new URL(page.url()).searchParams.has('code')).toBe(false);
});

test('configuration failure exits the shell with a usable access screen', async ({page,openApp}) => {
  const held=gate();
  await openApp('signed-out',page,{waitForReady:false});
  // Re-navigate with the configuration transport held, then failed.
  await page.route('**/api/config',async route=>{await held.wait;await route.fulfill({status:503,json:{error:'unavailable'}});});
  await page.reload();
  try {await expect(page.locator('.startup-skeleton')).toBeVisible();} finally {held.release();}
  await expect(page.getByRole('main').getByRole('alert')).toContainText('not configured');
  await expect(page.locator('.startup-skeleton,.app-shell .home')).toHaveCount(0);
});

for (const identity of ['signed-out','pending','rejected','inactive'] as const) {
  test(`fast ${identity} response never mounts a workspace`,async({page,openApp})=>{
    await watchPrivateMounts(page);
    await openApp(identity);
    await expect(page.locator('.startup-skeleton,.app-shell .home,.admin-avatar')).toHaveCount(0);
    expect(await page.evaluate(()=>(window as unknown as {privateMounts:number}).privateMounts)).toBe(0);
  });
}

test('Hebrew account switching clears private UI before re-verification',async({page,openApp,backend})=>{
  await openApp();
  await switchLanguage(page, 'he');
  const held=gate();
  const member=backend.raw.members.find(m=>m.id===ids.pending)!;
  await page.route('**/auth/v1/user',async route=>{await held.wait;await route.fulfill({json:{...member,email_confirmed_at:'2026-01-01',is_anonymous:false}});});
  await page.route('**/rest/v1/rpc/duty_load',route=>route.fulfill({json:backend.snapshot(ids.pending)}));
  await page.evaluate(id=>{
    const storageKey=Object.keys(localStorage).find(key=>key.endsWith('-auth'))!;
    const session=JSON.parse(localStorage.getItem(storageKey)!);
    session.user.id=id;session.user.email='pending@example.invalid';
    const payload=JSON.parse(atob(session.access_token.split('.')[1]));payload.sub=id;
    session.access_token=session.access_token.split('.')[0]+'.'+btoa(JSON.stringify(payload))+'.synthetic';
    localStorage.setItem(storageKey,JSON.stringify(session));
    const channel=new BroadcastChannel(storageKey);
    channel.postMessage({event:'SIGNED_IN',session});channel.close();
  },ids.pending);
  try {
    await expect(page.locator('.startup-skeleton')).toHaveAttribute('dir','rtl');
    await expect(page.getByRole('status')).toHaveText('טוען…');
    await expect(page.locator(PRIVATE)).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('Avery Admin');
  } finally {held.release();}
  await expect(page.getByRole('heading',{name:'ממתין לאישור'})).toBeVisible();
  await expect(page.locator('.startup-skeleton,.app-shell .home')).toHaveCount(0);
});
