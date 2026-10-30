// Real application + LOCAL Auth/PostgREST. No request interception or service key.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {webkit,devices,expect} from '@playwright/test';
import {createClient} from '@supabase/supabase-js';
import {assertToolbar,assertMonthMenu} from '../tests/browser/toolbar-assertions.ts';
import {traverseMonths} from '../tests/browser/month-navigation.ts';
import {zoomContext,setBrowserZoom} from '../tests/browser/zoom-context.mjs';
import {LOCAL_PASSWORD} from './local-supabase.mjs';
import {initialCalendarMonth} from '../lib/rota/calendar-dates.ts';
import {blocks,ownerMonth,dayOf,addDays} from '../lib/rota/engine.ts';
import {fromSnapshot,schedulePayload} from '../lib/supabase/snapshot.ts';
const origin=process.env.DUTY_RUNTIME_URL??'http://localhost:5173',out='work/runtime-investigation/corrected';
const config=await(await fetch(origin+'/api/config')).json();
assert.equal(config.url,'http://127.0.0.1:48321','Refuse hosted databases');
const client=createClient(config.url,config.key,{auth:{persistSession:false,autoRefreshToken:false}});
const login=await client.auth.signInWithPassword({email:'admin@duty.local',password:LOCAL_PASSWORD});
assert.ifError(login.error);
const load=async()=>{const r=await client.rpc('duty_load');assert.ifError(r.error);return r.data;};
const initial=await load();
assert(initial.members.every(m=>m.email.endsWith('@duty.local')),'Only isolated synthetic members');
const month=initialCalendarMonth();
await mkdir(out,{recursive:true});
const context=await zoomContext(),browser=context.browser();
const page=await context.newPage();
const errors=[];page.on('pageerror',error=>errors.push(error.message));
const assets=[];page.on('response',r=>{if(['stylesheet','script'].includes(r.request().resourceType()))assets.push({path:new URL(r.url()).pathname,status:r.status()});});
const states=[];
async function verifyState(state) {
 const navigation=await traverseMonths(page);
 states.push({state,navigation});
 for(const width of [1024,1280,1440]) {
  await page.setViewportSize({width,height:1000});
  for(const zoom of [1,1.25,1.5,2]) {
   assert.equal(await setBrowserZoom(context,page,zoom),zoom);
   for(const language of ['en','he']) {
    if(language==='he')await page.getByRole('button',{name:'Switch to Hebrew',exact:true}).click();
    if(width===1280&&state==='reopened')await traverseMonths(page);
    const toolbar=await assertToolbar(page);
    const menu=toolbar.containerWidth<960?await assertMonthMenu(page):null;
    states.push({state,width,zoom,language,toolbar,menu});
    if(language==='he')await page.getByRole('button',{name:'Switch to English',exact:true}).click();
   }
  }
 }
 await setBrowserZoom(context,page,1);await page.setViewportSize({width:1280,height:1000});
 const phoneBrowser=await webkit.launch();
 try {
  const storageState=await context.storageState();
  for(const width of [375,390,430]) {
   const phone=await phoneBrowser.newContext({...devices['iPhone 13'],viewport:{width,height:844},storageState,locale:'en-GB',timezoneId:'Asia/Jerusalem',reducedMotion:'reduce'});
   const p=await phone.newPage();await p.goto(origin);await expect(p.locator('.workflow-actions')).toBeVisible();
   if(state==='new')await p.getByRole('button',{name:'Next month',exact:true}).click();
   for(const language of ['en','he']) {
    if(language==='he')await p.getByRole('button',{name:'Switch to Hebrew',exact:true}).click();
    const toolbar=await assertToolbar(p),menu=await assertMonthMenu(p,true);
    states.push({state,width,language,browser:'webkit',toolbar,menu});
    await p.screenshot({path:`${out}/${state}-${width}-${language}.png`,scale:'css'});
   }
   await phone.close();
  }
 }finally{await phoneBrowser.close();}
}
try {
 await page.goto(origin);
 await page.getByLabel('Password',{exact:true}).fill(LOCAL_PASSWORD);
 await page.getByRole('button',{name:'Sign in locally',exact:true}).click();
 await expect(page.locator('.month-toolbar')).toBeVisible();
 if(process.argv.includes('--exercise-cancel')) {
  if(await page.getByRole('button',{name:'Generate month',exact:true}).count()) {
   await page.getByRole('button',{name:'Generate month',exact:true}).click();
   await expect(page.getByRole('button',{name:'Regenerate',exact:true})).toBeEnabled();
  }
  if(!(await load()).months.find(m=>m.month===month)?.current_publication_id) {
   // Two default LOCAL members cannot cover four weekends under the generator's
   // monthly cap. Seed only missing duties through the ordinary checked RPC.
   const raw=await load(),state=fromSnapshot(raw,login.data.user.id);
   for(const b of blocks(month,state.specials,state.splitWeekends).filter(b=>ownerMonth(b)===month)) {
    if(!state.assignments[b.id]?.primary)state.assignments[b.id]={primary:login.data.user.id};
   }
   const prepared=await client.rpc('duty_save_schedule',{p_state:schedulePayload(state),p_publish:null,p_revision:raw.revision});assert.ifError(prepared.error);
   await page.reload();await expect(page.getByRole('button',{name:'Publish',exact:true})).toBeEnabled();
   await page.getByRole('button',{name:'Publish',exact:true}).click();
   await page.getByRole('button',{name:'Publish schedule',exact:true}).click();
   await expect(page.getByRole('button',{name:'Reopen draft',exact:true})).toBeVisible();
  }
  if(await page.getByRole('button',{name:'Reopen draft',exact:true}).count())await page.getByRole('button',{name:'Reopen draft',exact:true}).click();
  // A real changed draft proves that cancellation restores the publication.
  await page.getByRole('button',{name:'Regenerate',exact:true}).click();
  await expect(page.getByRole('button',{name:'Regenerate',exact:true})).toBeEnabled();
  const before=await load(),pub=before.months.find(m=>m.month===month).current_publication_id;
  const fields=rows=>rows.map(row=>{const r={...row};delete r.id;delete r.publication_id;return r;}).sort((a,b)=>a.day.localeCompare(b.day));
  const owned=r=>(dayOf(r.day)===6?addDays(r.day,-1):r.day).slice(0,7)===month;
  const expected=fields(before.assignments.filter(r=>r.publication_id===pub&&owned(r)));
  assert.notDeepEqual(fields(before.assignments.filter(r=>r.publication_id===null&&owned(r))),expected,'Regeneration must change the draft for this proof');
  await page.getByRole('button',{name:'Cancel draft',exact:true}).click();
  const rpc=page.waitForResponse(r=>r.url()===config.url+'/rest/v1/rpc/duty_cancel_draft');
  await page.getByRole('button',{name:'Discard draft',exact:true}).click();
  const response=await rpc;assert.equal(response.status(),204);
  await expect(page.getByRole('button',{name:'Reopen draft',exact:true})).toBeVisible();
  const after=await load();
  assert.equal(after.months.find(m=>m.month===month).status,'published');
  assert.deepEqual(after.assignments.filter(r=>r.publication_id===null&&owned(r)),[]);
  assert.deepEqual(fields(after.assignments.filter(r=>r.publication_id===pub&&owned(r))),expected);
  assert.deepEqual(after.publications,before.publications);
  assert.deepEqual(after.assignments.filter(r=>r.publication_id!==null||!owned(r)),before.assignments.filter(r=>r.publication_id!==null||!owned(r)));
  const cancellation={target:config.url,month,httpStatus:response.status(),status:'published',publishedAssignments:expected.length,workingAssignments:0,revisionBefore:before.revision,revisionAfter:after.revision,historyPreserved:true,otherAssignmentsPreserved:true};
  await writeFile(`${out}/cancel-draft.json`,JSON.stringify(cancellation,null,2));console.log('Real browser Cancel Draft:',JSON.stringify(cancellation));
  await verifyState('published');
  await page.getByRole('button',{name:'Next month',exact:true}).click();
  await expect(page.getByRole('button',{name:'Generate month',exact:true})).toBeVisible();
  await verifyState('new');
  await page.getByRole('button',{name:'Previous month',exact:true}).click();
  await page.getByRole('button',{name:'Reopen draft',exact:true}).click();
  await expect(page.getByRole('button',{name:'Cancel draft',exact:true})).toBeVisible();
 }
 await verifyState('reopened');
 const evidence=[];
 for(const width of [1024,1280,1440]) {
  await page.setViewportSize({width,height:1000});
  for(const language of ['en','he']) {
   if(language==='he')await page.getByRole('button',{name:'Switch to Hebrew',exact:true}).click();
   evidence.push({browser:'chromium',language,...await assertToolbar(page)});
   if(width===1280&&language==='en')await page.screenshot({path:`${out}/desktop-1280-en.png`,fullPage:true});
  }
  await page.getByRole('button',{name:'Switch to English',exact:true}).click();
 }
 await page.reload();await expect(page.locator('.month-toolbar')).toBeVisible();
 evidence.push({session:'normal-reload',...await assertToolbar(page)});
 const state=await context.storageState();
 const phoneBrowser=await webkit.launch();
 try {
  for(const width of [375,390,430]) {
   const phone=await phoneBrowser.newContext({...devices['iPhone 13'],viewport:{width,height:844},storageState:state,locale:'en-GB',timezoneId:'Asia/Jerusalem',reducedMotion:'reduce'});
   const p=await phone.newPage();await p.goto(origin);await expect(p.locator('.month-toolbar')).toBeVisible();
   for(const language of ['en','he']) {
    if(language==='he')await p.getByRole('button',{name:'Switch to Hebrew',exact:true}).click();
    evidence.push({browser:'webkit',language,...await assertToolbar(p)});
    if(width===375)await p.screenshot({path:`${out}/iphone-375-${language}.png`,scale:'css'});
   }
   await phone.close();
  }
 } finally {await phoneBrowser.close();}
 const fresh=await browser.newContext({storageState:state,viewport:{width:1280,height:1000}});
 const freshPage=await fresh.newPage();await freshPage.goto(origin);await expect(freshPage.locator('.month-toolbar')).toBeVisible();
 evidence.push({session:'fresh-context',...await assertToolbar(freshPage)});await fresh.close();
 assert.deepEqual(errors,[]);assert(assets.every(a=>a.status===200||a.status===304),'Asset downloads: '+JSON.stringify(assets.filter(a=>a.status!==200&&a.status!==304)));
 await writeFile(`${out}/computed.json`,JSON.stringify({target:config.url,evidence,assets},null,2));
 await writeFile(`${out}/states-and-zoom.json`,JSON.stringify({target:config.url,states},null,2));
 console.log(`PASS: real LOCAL application, reload/fresh session, desktop 1024/1280/1440 + iPhone WebKit 375/390/430, both languages. Screenshots: ${out}`);
} finally {await context.close();await client.auth.signOut({scope:'local'});}
