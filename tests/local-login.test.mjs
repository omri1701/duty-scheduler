import test from 'node:test';
import assert from 'node:assert/strict';
import {PROJECTS} from '../lib/supabase/environment.ts';
globalThis.window={location:{origin:'http://localhost:5173'},open:()=>{}};

test('local password login uses verified Supabase Auth; hosted password login is unavailable',async t=>{
 for(const url of ['http://127.0.0.1:58321',PROJECTS.dev,PROJECTS.prod]){
  const mod=await import(`../lib/supabase/client.ts?login=${encodeURIComponent(url)}`);
  const mock=t.mock.method(globalThis,'fetch',async()=>Response.json({url,key:'sb_publishable_synthetic'}));
  const client=await mod.getSupabase();
  let calls=0;
  t.mock.method(client.auth,'signInWithPassword',async credentials=>{calls++;assert.deepEqual(credentials,{email:'admin@duty.local',password:'synthetic'});return {error:null};});
  if(url.startsWith('http:')){await mod.signInLocally('admin@duty.local','synthetic');assert.equal(calls,1);await assert.rejects(mod.signInWithGoogle(),/local test/);}
  else {await assert.rejects(mod.signInLocally('admin@duty.local','synthetic'),/only for LOCAL/);assert.equal(calls,0);}
  await client.auth.stopAutoRefresh();mock.mock.restore();
 }
});

test('Production inspection retains hosted Google redirects and exchanges only an exact return URL with PKCE',async t=>{
 const mod=await import('../lib/supabase/client.ts?inspection-login');
 t.mock.method(globalThis,'fetch',async url=>url==='/api/config'?Response.json({url:PROJECTS.prod,key:'sb_publishable_synthetic'}):Response.json({external:{google:true}}));
 const client=await mod.getSupabase();
 const popup=t.mock.method(window,'open',()=>{});
 t.mock.method(client.auth,'signInWithOAuth',async request=>{assert.equal(request.provider,'google');assert.deepEqual(request.options,{redirectTo:'https://duty-scheduler-prod.vercel.app/',skipBrowserRedirect:true});return {data:{url:PROJECTS.prod+'/auth/v1/authorize'},error:null};});
 await mod.signInWithGoogle();
 assert.equal(popup.mock.callCount(),1);
 const exchange=t.mock.method(client.auth,'exchangeCodeForSession',async(code,options)=>{assert.equal(code,'one-time-synthetic');assert.deepEqual(options,{flowId:'synthetic-flow'});return {error:null};});
 for(const callback of ['https://evil.invalid/?code=one-time-synthetic','https://duty-scheduler-prod.vercel.app/path?code=one-time-synthetic','https://duty-scheduler-prod.vercel.app/','https://user:password@duty-scheduler-prod.vercel.app/?code=one-time-synthetic'])await assert.rejects(mod.completeInspectionLogin(callback),/Invalid Google/);
 assert.equal(exchange.mock.callCount(),0);
 await mod.completeInspectionLogin('https://duty-scheduler-prod.vercel.app/?code=one-time-synthetic&sb_flow_id=synthetic-flow');
 assert.equal(exchange.mock.callCount(),1);
 await client.auth.stopAutoRefresh();
});
