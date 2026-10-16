import {test, expect, ids} from './fixtures';

function gate() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => {release = resolve;});
  return {wait, release};
}

async function watchPrivateMounts(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    Object.assign(window, {privateMounts: 0,accessMounts:0});
    new MutationObserver(() => {
      if (document.querySelector('.calendar-grid,.admin-avatar')) (window as unknown as {privateMounts:number}).privateMounts++;
      if (document.querySelector('.access-card')) (window as unknown as {accessMounts:number}).accessMounts++;
    }).observe(document, {childList:true,subtree:true});
  });
}

for (const phase of ['config', 'auth', 'snapshot'] as const) {
  test(`public shell while ${phase} is slow, then immediate verified calendar`, async ({page,openApp,backend}, info) => {
    const held=gate();
    if (phase==='config') backend.configGate=held.wait;
    if (phase==='auth') backend.authGate=held.wait;
    if (phase==='snapshot') backend.loadGate=held.wait;
    const requests:string[]=[];
    page.on('request',request=>{const path=new URL(request.url()).pathname;if(['/api/config','/auth/v1/user','/rest/v1/rpc/duty_load'].includes(path))requests.push(path);});
    await watchPrivateMounts(page);
    await openApp('admin',page,{waitForReady:false});
    const shell=page.locator('.startup-skeleton');
    try {
      await expect(shell).toBeVisible();
      await expect(shell).toHaveAttribute('aria-busy','true');
      await expect(shell.getByRole('status')).toHaveText('Loading calendar\u2026');
      await expect(shell.locator('[inert][aria-hidden=true]')).toHaveCount(1);
      await expect(shell.locator('button,a,input,[tabindex]')).toHaveCount(0);
      await expect(shell).not.toContainText(/Avery|Atlas|Synthetic vacation|Holiday coverage|example.invalid|November|Draft|Published/);
      await expect(page.locator('.calendar-grid,.admin-avatar')).toHaveCount(0);
      expect(await page.evaluate(()=>(window as unknown as {privateMounts:number}).privateMounts)).toBe(0);
      await page.keyboard.press('Tab');
      expect(await shell.evaluate(node=>node.contains(document.activeElement))).toBe(false);
      const before=await page.locator('.topbar').boundingBox();
      const navBefore=await page.locator('.nav-row').boundingBox();
      if (phase==='auth') await info.attach('startup-shell',{body:await page.screenshot(),contentType:'image/png'});
      held.release();
      await expect(page.getByRole('button',{name:'My profile'})).toBeVisible();
      await expect(shell).toHaveCount(0);
      expect(await page.evaluate(()=>(window as unknown as {accessMounts:number}).accessMounts)).toBe(0);
      expect(await page.locator('.topbar').boundingBox()).toEqual(before);
      if (info.project.name==='mobile') expect(await page.locator('.nav-row').boundingBox()).toEqual(navBefore);
      expect(backend.calls.map(c=>c.name)).toEqual(['duty_load']);
      expect(requests.sort()).toEqual(['/api/config','/auth/v1/user','/rest/v1/rpc/duty_load']);
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
  await expect(page.locator('.startup-skeleton,.calendar-grid,.admin-avatar')).toHaveCount(0);
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
    await expect(page.locator('.calendar-grid,.admin-avatar')).toHaveCount(0);
    expect(await page.evaluate(()=>(window as unknown as {accessMounts:number}).accessMounts)).toBe(0);
  } finally {held.release();}
  await expect(page.getByRole('button',{name:'My profile'})).toBeVisible();
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
  await expect(page.locator('.startup-skeleton,.calendar-grid')).toHaveCount(0);
});

for (const identity of ['signed-out','pending','rejected','inactive'] as const) {
  test(`fast ${identity} response never mounts a workspace`,async({page,openApp})=>{
    await watchPrivateMounts(page);
    await openApp(identity);
    await expect(page.locator('.startup-skeleton,.calendar-grid,.admin-avatar')).toHaveCount(0);
    expect(await page.evaluate(()=>(window as unknown as {privateMounts:number}).privateMounts)).toBe(0);
  });
}

test('Hebrew account switching clears private UI before re-verification',async({page,openApp,backend})=>{
  await openApp();
  await page.getByRole('button',{name:'Switch to Hebrew'}).click();
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
    await expect(page.getByRole('status')).toHaveText('\u05d8\u05d5\u05e2\u05df \u05d0\u05ea \u05d4\u05dc\u05d5\u05d7\u2026');
    await expect(page.locator('.calendar-grid,.admin-avatar')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('Avery Admin');
  } finally {held.release();}
  await expect(page.getByRole('heading',{name:'\u05de\u05de\u05ea\u05d9\u05df \u05dc\u05d0\u05d9\u05e9\u05d5\u05e8'})).toBeVisible();
  await expect(page.locator('.startup-skeleton,.calendar-grid')).toHaveCount(0);
});

for(const width of [320,375,390,430,768,1440]) {
  for(const lang of ['en','he'] as const) {
    test(`shell geometry at ${width}px in ${lang}`,async({page,openApp,backend},info)=>{
      test.skip(info.project.name!=='desktop','Run viewport matrix once.');
      await page.setViewportSize({width,height:900});
      await page.emulateMedia({reducedMotion:lang==='en'?'reduce':'no-preference'});
      backend.url='http://127.0.0.1:54321';backend.runtimeOrigin='http://localhost:8787';
      await openApp('signed-out');
      if(lang==='he') await page.getByRole('button',{name:'\u05e2\u05d1\u05e8\u05d9\u05ea',exact:true}).click();
      const held=gate();backend.authGate=held.wait;
      await page.getByLabel(lang==='en'?'Password':'\u05e1\u05d9\u05e1\u05de\u05d4',{exact:true}).fill('synthetic-only');
      await page.getByRole('button',{name:lang==='en'?'Sign in locally':'\u05d4\u05ea\u05d7\u05d1\u05e8\u05d5\u05ea \u05de\u05e7\u05d5\u05de\u05d9\u05ea',exact:true}).click();
      const shell=page.locator('.startup-skeleton');
      try {
        await expect(shell).toBeVisible();
        await expect(shell).toHaveAttribute('dir',lang==='he'?'rtl':'ltr');
        expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width);
        const header=await page.locator('.topbar').boundingBox();
        const nav=await page.locator('.nav-row').boundingBox();
        const calendar=await page.locator('.calendar-panel').boundingBox();
        const columns=await page.locator('.skeleton-grid').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').map(Number.parseFloat));
        expect(columns).toHaveLength(7);
        expect(Math.max(...columns)-Math.min(...columns)).toBeLessThan(1);
        await expect(page.locator('.nav-row')).toHaveCSS('position',width<=600?'fixed':'static');
        expect(await shell.evaluate(el=>el.getAnimations({subtree:true}).length)).toBe(0);
        await info.attach('startup-shell',{body:await page.screenshot(),contentType:'image/png'});
        held.release();
        await expect(page.getByRole('button',{name:lang==='en'?'My profile':'\u05d4\u05e4\u05e8\u05d5\u05e4\u05d9\u05dc \u05e9\u05dc\u05d9',exact:true})).toBeVisible();
        expect(await page.locator('.topbar').boundingBox()).toEqual(header);
        if(width<=600) expect(await page.locator('.nav-row').boundingBox()).toEqual(nav);
        const ready=await page.locator('.calendar-panel').boundingBox();
        expect(ready?.x).toBe(calendar?.x);
        expect(ready?.width).toBe(calendar?.width);
        expect(Math.abs(ready!.y-calendar!.y)).toBeLessThan(1);
        if(lang==='en') await expect(page.locator('.app-shell')).toHaveCSS('animation-name','none');
      } finally {held.release();}
    });
  }
}
