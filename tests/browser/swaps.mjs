// Optional production browser check with synthetic Supabase responses.
// Requires externally available Playwright/Chrome; no production data is used.
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const {chromium}=createRequire(import.meta.url)('playwright');
const root=process.env.DUTY_PREVIEW_URL||'http://127.0.0.1:8787';
const ids={admin:'20000000-0000-0000-0000-000000000001',a:'20000000-0000-0000-0000-000000000002',b:'20000000-0000-0000-0000-000000000003',c:'20000000-0000-0000-0000-000000000004'};
const now=new Date(),month=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+1,1)).toISOString().slice(0,7),pub='20000000-0000-0000-0000-000000000010';
const members=Object.entries(ids).map(([key,id],i)=>({id,name:'Engineer '+key.toUpperCase(),email:key+'@example.invalid',role:key==='admin'?'admin':'engineer',status:'approved',active:true,seniority:i,color:['#adc9ee','#f0ba95','#c9b1de','#9bcfbe'][i]}));
const duties=['a','b','c','admin'].map((key,i)=>({id:`20000000-0000-0000-0000-00000000002${i}`,publication_id:pub,day:month+`-0${i+2}`,end_day:month+`-0${i+3}`,primary_id:ids[key],secondary_id:null,points:1,title:'',extra_points:0,manager_override:false}));
let revision=1,requests=[],invalidateNext=false;
const actions=[];
function snapshot(key){return {revision,members,months:[{month,deadline:month+'-01',status:'published',generated:true,current_publication_id:pub,publication_sequence:1}],constraints:[],assignments:key==='admin'?[...duties,...duties.map(d=>({...d,id:d.id+'-draft',publication_id:null}))]:duties,publications:[{id:pub,month,version:1,published_at:now.toISOString(),published_by:ids.admin}],roles:[{code:'admin',label:'Admin',can_manage:true},{code:'engineer',label:'Engineer',can_manage:false}],memberStatuses:[],monthStatuses:[],constraintTypes:[],swapRequests:requests.filter(r=>r.requester_id===ids[key]||(r.other_id===ids[key]&&r.status==='awaiting_engineer')||(key==='admin'&&r.status==='awaiting_admin'))}}
async function client(browser,key,width=1100){
 const context=await browser.newContext({viewport:{width,height:900}});
 const user={id:ids[key],email:key+'@example.invalid',aud:'authenticated',role:'authenticated',created_at:now.toISOString(),app_metadata:{provider:'google',providers:['google']},user_metadata:{full_name:'Engineer '+key.toUpperCase()}};
 const access=[Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url'),Buffer.from(JSON.stringify({sub:user.id,exp:Math.floor(Date.now()/1000)+3600,role:'authenticated'})).toString('base64url'),'synthetic'].join('.');
 await context.addInitScript(({access,user})=>localStorage.setItem('sb-swap-test-auth-token',JSON.stringify({access_token:access,refresh_token:'synthetic-only',expires_at:Math.floor(Date.now()/1000)+3600,expires_in:3600,token_type:'bearer',user})),{access,user});
 await context.route('**/api/config',r=>r.fulfill({json:{url:'https://swap-test.supabase.co',key:'sb_publishable_synthetic_only'}}));
 await context.route('https://swap-test.supabase.co/**',async route=>{
  const url=route.request().url();let data=null;
  if(url.includes('/auth/v1/user'))data=user;
  else if(url.includes('/rest/v1/rpc/duty_load'))data=snapshot(key);
  else if(url.includes('/rest/v1/rpc/duty_request_swap')){
   const p=route.request().postDataJSON();actions.push({key,action:'request',p});assert.equal(p.p_revision,revision);
   const from=duties.find(d=>d.id===p.p_from),to=duties.find(d=>d.id===p.p_to);assert.equal(from.primary_id,user.id);
   requests.unshift({id:crypto.randomUUID(),month,source_publication_id:pub,requester_id:user.id,other_id:to.primary_id,from_day:from.day,from_end_day:from.end_day,to_day:to.day,to_end_day:to.end_day,explanation:p.p_explanation,status:'awaiting_engineer',accepted_by:null,accepted_at:null,created_at:new Date().toISOString(),resolved_at:null,resolved_by:null,result_publication_id:null,override_reason:''});revision++;
  }else if(url.includes('/rest/v1/rpc/duty_resolve_swap')){
   const p=route.request().postDataJSON();actions.push({key,action:p.p_action,p});assert.equal(p.p_revision,revision);
   const r=requests.find(r=>r.id===p.p_request);
   if(invalidateNext){r.status='invalidated';data='invalidated';invalidateNext=false;revision++}
   else {
   if(['accept','decline'].includes(p.p_action)){assert.equal(user.id,r.other_id);assert.equal(r.status,'awaiting_engineer')}
   if(['approve','reject'].includes(p.p_action)){assert.equal(key,'admin');assert.equal(r.status,'awaiting_admin')}
   if(p.p_action==='cancel')assert.equal(user.id,r.requester_id);
   r.status={accept:'awaiting_admin',decline:'declined',cancel:'cancelled',reject:'rejected',approve:'approved'}[p.p_action];
   if(p.p_action==='accept'){r.accepted_by=user.id;r.accepted_at=new Date().toISOString()}
   if(p.p_action==='approve'){const a=duties.find(d=>d.day===r.from_day),b=duties.find(d=>d.day===r.to_day);[a.primary_id,b.primary_id]=[b.primary_id,a.primary_id]}
   r.override_reason=p.p_override_reason;revision++;data=r.status;
   }
  }else if(!url.includes('duty_join'))throw Error('Unexpected synthetic endpoint '+url);
  await route.fulfill({json:data});
 });
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(root,{waitUntil:'networkidle'});await page.getByRole('button',{name:'Sign out',exact:true}).waitFor();
 return {context,page,errors};
}
const cell=(page,index)=>page.locator(`.calendar-grid button[data-gesture-key="${duties[index].day}"]`);
async function select(page){await cell(page,0).focus();await page.keyboard.press('Enter');await cell(page,1).focus();await page.keyboard.press('Space');await page.getByRole('dialog').waitFor()}
async function confirm(page){await page.getByRole('button',{name:'Confirm Request',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'})}
async function touch(page,type,x,y){await page.evaluate(({type,x,y})=>{
 const touch=new Touch({identifier:1,target:document.elementFromPoint(x,y),clientX:x,clientY:y});
 const target=document.querySelector('.calendar-grid');target.dispatchEvent(new TouchEvent(type,{bubbles:true,cancelable:true,touches:type==='touchend'?[]:[touch],changedTouches:[touch]}));
},{type,x,y})}
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.DUTY_CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
  const a=await client(browser,'a'),b=await client(browser,'b',390),c=await client(browser,'c',390),admin=await client(browser,'admin');
  for(const client of [a,b,c,admin])assert.equal(await client.page.locator('.swap-requests').count(),0,'Empty section including heading is hidden');
  // Desktop drag uses real pointer movement on the existing gesture container.
  await cell(a.page,0).scrollIntoViewIfNeeded();const from=await cell(a.page,0).boundingBox(),to=await cell(a.page,1).boundingBox();
  await a.page.mouse.move(from.x+from.width/2,from.y+from.height/2);await a.page.mouse.down();await a.page.mouse.move(to.x+to.width/2,to.y+to.height/2,{steps:8});
  assert.equal(await cell(a.page,1).evaluate(el=>el.classList.contains('drag-target')),true);
  await a.page.mouse.up();await a.page.getByRole('dialog').waitFor();
  assert.equal(await a.page.getByRole('dialog').getByText('Engineer A',{exact:true}).count(),1);
  assert.equal(await a.page.getByRole('dialog').getByText('Engineer B',{exact:true}).count(),1);
  await a.page.getByLabel('Explanation (optional)').fill('Desktop request');await confirm(a.page);
  assert.equal(duties[0].primary_id,ids.a,'Request does not exchange assignments');
  await admin.page.reload();assert.equal(await admin.page.locator('.swap-requests').count(),0,'Admin cannot approve before consent');
  await b.page.reload();await b.page.getByRole('button',{name:'Decline',exact:true}).click();await b.page.locator('.swap-requests').waitFor({state:'hidden'});
  await a.page.reload();await a.page.getByText('Declined',{exact:true}).waitFor();
  // Keyboard choice and Escape work; Cancel clears the confirmation.
  await cell(a.page,0).focus();await a.page.keyboard.press('Enter');await a.page.keyboard.press('Escape');assert.equal(await cell(a.page,0).getAttribute('aria-pressed'),'false');
  await select(a.page);await a.page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(actions.filter(a=>a.action==='request').length,1);
  await select(a.page);await confirm(a.page);await b.page.reload();await b.page.getByRole('button',{name:'Accept',exact:true}).click();
  await admin.page.reload();await admin.page.getByRole('button',{name:'Reject',exact:true}).click();await a.page.reload();await a.page.getByText('Rejected',{exact:true}).waitFor();
  // Mobile native TouchEvent long press invokes the same gesture implementation.
  await a.page.setViewportSize({width:390,height:900});await cell(a.page,0).scrollIntoViewIfNeeded();
  const mf=await cell(a.page,0).boundingBox(),mt=await cell(a.page,1).boundingBox(),fx=mf.x+mf.width/2,fy=mf.y+mf.height/2,tx=mt.x+mt.width/2,ty=mt.y+mt.height/2;
  await touch(a.page,'touchstart',fx,fy);await touch(a.page,'touchmove',fx,fy+30);await a.page.waitForTimeout(400);await touch(a.page,'touchend',fx,fy+30);assert.equal(await a.page.getByRole('dialog').count(),0,'Scroll before long press does not request');
  await touch(a.page,'touchstart',fx,fy);await a.page.waitForTimeout(400);await touch(a.page,'touchmove',tx,ty);await touch(a.page,'touchend',tx,ty);await a.page.getByRole('dialog').waitFor();await confirm(a.page);
  await b.page.reload();await b.page.getByRole('button',{name:'Accept',exact:true}).click();
  // SQL suite separately proves this reassignment. Here test the four UI views.
  const r=requests[0];duties[1].primary_id=ids.c;r.other_id=ids.c;r.status='awaiting_engineer';r.accepted_by=null;r.accepted_at=null;revision++;
  await Promise.all([a.page.reload(),b.page.reload(),c.page.reload(),admin.page.reload()]);
  assert.equal(await b.page.locator('.swap-requests').count(),0);assert.equal(await admin.page.locator('.swap-requests').count(),0);
  await c.page.getByRole('button',{name:'Accept',exact:true}).waitFor();await a.page.getByText('Awaiting Engineer',{exact:true}).waitFor();
  // Actionable requests survive a calendar month change.
  await c.page.getByRole('button',{name:'Next month',exact:true}).click();await c.page.getByRole('button',{name:'Accept',exact:true}).click();
  await admin.page.reload();await admin.page.getByRole('button',{name:'Approve',exact:true}).click();
  await admin.page.getByLabel('Explicitly override availability conflicts').click();assert.equal(await admin.page.getByRole('button',{name:'Approve & publish swap'}).isDisabled(),true);
  await admin.page.getByLabel('Required audit reason').fill('Browser audit reason');await admin.page.getByRole('button',{name:'Approve & publish swap'}).click();
  assert.equal(actions.at(-1).p.p_override_reason,'Browser audit reason');assert.equal(duties[0].primary_id,ids.c);
  await a.page.reload();await cell(a.page,1).focus();await a.page.keyboard.press('Enter');await cell(a.page,2).focus();await a.page.keyboard.press('Space');await confirm(a.page);
  await c.page.reload();invalidateNext=true;await c.page.getByRole('button',{name:'Accept',exact:true}).click();
  await c.page.getByText('This request was invalidated because its published duties are no longer eligible.',{exact:true}).waitFor();
  await a.page.reload();await a.page.getByText('Invalidated',{exact:true}).waitFor();
  await a.page.getByRole('button',{name:'Switch to Hebrew'}).click();assert.equal(await a.page.locator('html').getAttribute('dir'),'rtl');
  await a.page.getByRole('heading',{name:'בקשות החלפה',exact:true}).waitFor();assert.equal(await a.page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  await admin.page.getByRole('button',{name:'Published',exact:true}).click();assert.equal(await admin.page.getByRole('button',{name:'Special block',exact:true}).isVisible(),false);
  await admin.page.getByRole('button',{name:'Whole team',exact:true}).click();await cell(admin.page,0).click();await admin.page.getByRole('dialog').waitFor();
  assert.deepEqual([...a.errors,...b.errors,...c.errors,...admin.errors],[]);
  console.log('PASS: four synthetic production browser contexts; desktop drag/drop target, keyboard/Escape/Cancel, mobile long press/scroll, consent/decline/admin review, retarget views, all-month actions, hidden empty sections, Hebrew RTL, no mobile overflow, preserved admin editing. DB enforcement tested separately.');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)});
