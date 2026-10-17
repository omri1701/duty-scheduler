import {readdirSync,readFileSync} from 'node:fs';
import {test,expect,ids} from './fixtures';

function chunk(text:string){
 const files=readdirSync('.next/static/chunks').filter(f=>f.endsWith('.js')&&readFileSync(`.next/static/chunks/${f}`,'utf8').includes(text));
 expect(files,`one production chunk containing ${text}`).toHaveLength(1);
 return `/_next/static/chunks/${files[0]}`;
}
function gate(){let release!:()=>void;const wait=new Promise<void>(r=>release=r);return {wait,release}}

for(const identity of ['admin','a'] as const)test(`calendar works with optional chunks held: ${identity}`,async({page,openApp})=>{
 const optional=['Save name','Published versions','Team order','Prefer duty'].map(chunk),requested:string[]=[];
 page.on('request',r=>{if(optional.includes(new URL(r.url()).pathname))requested.push(new URL(r.url()).pathname)});
 await openApp(identity);expect(requested).toEqual([]);
 const held=gate();let blocked=0;
 await page.route('**/_next/static/chunks/*.js',async route=>{blocked++;await held.wait;await route.continue()});
 try{
  await page.getByRole('tab').nth(2).click();await expect(page.getByRole('status')).toHaveText('Loading…');
  await expect.poll(()=>blocked).toBeGreaterThan(0);
  await page.getByRole('tab').nth(0).click();
  const grid=await page.locator('.calendar-grid').boundingBox();
  await page.getByRole('button',{name:'Next month',exact:true}).click();await expect(page.locator('.month-title h2')).toHaveText('December 2026');
  await page.getByRole('button',{name:'Previous month',exact:true}).click();
  await page.getByRole('button',{name:'My duties',exact:true}).click();await expect(page.getByRole('button',{name:'My duties',exact:true})).toHaveClass(/selected/);
  await page.getByRole('button',{name:'Whole team',exact:true}).click();
  expect(await page.locator('.calendar-grid').boundingBox()).toEqual(grid);
 }finally{held.release()}
 await page.getByRole('tab').nth(2).click();await expect(page.getByRole('heading',{name:'Team order',exact:true})).toBeVisible();
 const handle=page.getByRole('button',{name:/Drag to reorder/}).first();
 if(identity==='a')await expect(handle).toBeDisabled();else await expect(handle).toBeEnabled();
});

test('failed optional chunk retries locally, preserves profile saves and keyboard focus',async({page,openApp,backend})=>{
 const profile=chunk('Save name');await openApp();let attempts=0,recovered=false;
 // Turbopack retries transient network failures once before rejecting the import.
 await page.route(`**${profile}`,route=>{attempts++;return recovered?route.continue():route.fulfill({status:503,body:'Temporarily unavailable'})});
 const trigger=page.getByRole('button',{name:'My profile',exact:true});await trigger.focus();await page.keyboard.press('Enter');
 await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Could not load this feature');
 const failedAttempts=attempts;recovered=true;await page.getByRole('button',{name:'Retry',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'Display name'})).toHaveValue('Avery Admin');expect(attempts).toBeGreaterThan(failedAttempts);
 await page.getByRole('textbox',{name:'Display name'}).fill('Updated Admin');await page.getByRole('button',{name:'Save name',exact:true}).click();
 await expect(page.getByRole('dialog')).toBeHidden();await expect(trigger).toBeFocused();
 expect(backend.calls.filter(c=>c.name==='duty_rename_self').map(c=>c.params.p_revision)).toEqual([1]);
 await trigger.click();await expect(page.getByRole('textbox',{name:'Display name'})).toHaveValue('Updated Admin');
 await page.keyboard.press('Escape');await expect(trigger).toBeFocused();
});

test('late dialog code cannot reopen a dismissed modal or expose the signed-out workspace',async({page,openApp})=>{
 const profile=chunk('Save name'),held=gate();await openApp();let requested=false;
 await page.route(`**${profile}`,async route=>{requested=true;await held.wait;await route.continue()});
 try{
  await page.getByRole('button',{name:'My profile',exact:true}).click();await expect(page.getByRole('dialog').getByRole('status')).toHaveText('Loading…');
  await expect.poll(()=>requested).toBe(true);await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toBeHidden();
  await page.getByRole('button',{name:'Sign out',exact:true}).click();await expect(page.getByRole('button',{name:'Continue with Google'})).toBeVisible();
 }finally{held.release()}
 await page.evaluate(()=>new Promise(requestAnimationFrame));await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.locator('body')).not.toContainText('Avery Admin');
 await openApp('a');await page.getByRole('button',{name:'My profile',exact:true}).click();await expect(page.getByRole('textbox',{name:'Display name'})).toHaveValue('Alex Atlas');
});

test('account switching discards a pending private feature before its chunk completes',async({page,openApp,backend})=>{
 const profile=chunk('Save name'),held=gate();await openApp();
 await page.route(`**${profile}`,async route=>{await held.wait;await route.continue()});
 await page.getByRole('button',{name:'My profile',exact:true}).click();await expect(page.getByRole('dialog').getByRole('status')).toBeVisible();
 const member=backend.raw.members.find(m=>m.id===ids.pending)!;
 await page.route('**/auth/v1/user',route=>route.fulfill({json:{...member,email_confirmed_at:'2026-01-01',is_anonymous:false}}));
 await page.route('**/rest/v1/rpc/duty_load',route=>route.fulfill({json:backend.snapshot(ids.pending)}));
 try{
  await page.evaluate(id=>{
   const key=Object.keys(localStorage).find(k=>k.endsWith('-auth'))!,session=JSON.parse(localStorage.getItem(key)!);
   session.user.id=id;session.user.email='pending@example.invalid';const payload=JSON.parse(atob(session.access_token.split('.')[1]));payload.sub=id;
   session.access_token=session.access_token.split('.')[0]+'.'+btoa(JSON.stringify(payload))+'.synthetic';localStorage.setItem(key,JSON.stringify(session));
   const channel=new BroadcastChannel(key);channel.postMessage({event:'SIGNED_IN',session});channel.close();
  },ids.pending);
  await expect(page.getByRole('heading',{name:'Waiting for approval'})).toBeVisible();
 }finally{held.release()}
 await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.locator('body')).not.toContainText('Avery Admin');
});

test('secondary tab failures keep Schedule usable and retry in Hebrew',async({page,openApp})=>{
 const team=chunk('Team order');await openApp();await page.getByRole('button',{name:'Switch to Hebrew'}).click();let recovered=false;
 await page.route(`**${team}`,route=>recovered?route.continue():route.fulfill({status:503,body:'Temporarily unavailable'}));
 await page.getByRole('tab').nth(2).click();await expect(page.getByRole('alert')).toContainText('לא ניתן לטעון כרגע');
 await expect(page.locator('.team-panel')).toHaveAttribute('dir','rtl');
 await page.getByRole('tab').nth(0).click();await expect(page.locator('.calendar-grid')).toBeVisible();
 await page.getByRole('tab').nth(2).click();recovered=true;await page.getByRole('button',{name:'ניסיון נוסף',exact:true}).click();
 await expect(page.locator('.team-list')).toBeVisible();
});

test('first mobile month-menu keyboard intent loads the menu and returns focus',async({page,openApp},info)=>{
 test.skip(info.project.name==='desktop','Phone-only menu');
 await openApp();const trigger=page.getByRole('button',{name:'Month actions',exact:true});
 await trigger.focus();await page.keyboard.press('ArrowDown');await expect(page.getByRole('menuitem',{name:'Versions',exact:true})).toBeVisible();
 await page.keyboard.press('Escape');await expect(trigger).toBeFocused();
 await trigger.click();await page.getByRole('menuitem',{name:'Versions',exact:true}).click();await expect(page.locator('.history-calendar')).toBeVisible();
});
