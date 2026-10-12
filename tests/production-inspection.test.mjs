import test from 'node:test';
import assert from 'node:assert/strict';
import {PROJECTS,resolveEnvironment} from '../lib/supabase/environment.ts';
import {registerEnvironment,guardedFetch,signOutSafely} from '../lib/supabase/write-policy.ts';
import {createWorkspace} from '../lib/supabase/workspace.ts';

test('Production connect/refresh never onboard and every mutation is blocked before dispatch',async()=>{
 const calls=[],snapshot={revision:1,members:[],months:[],assignments:[],constraints:[],publications:[],roles:[],memberStatuses:[],monthStatuses:[],constraintTypes:[]};
 const client={rpc:async name=>{calls.push(name);return {data:snapshot,error:null}}};
 registerEnvironment(client,resolveEnvironment(PROJECTS.prod,'http://localhost:5173'));
 const workspace=createWorkspace({snapshot:()=>{},saving:()=>{},error:()=>{}});
 await workspace.connect(client,{id:'synthetic',email:'synthetic@example.invalid'});
 await workspace.refresh();
 for(const name of ['duty_save_schedule','duty_set_constraints','duty_rename_self','duty_set_role','duty_restore_publication','duty_delete_publication','duty_request_swap','duty_resolve_swap','duty_review_member','future_unknown_write'])await assert.rejects(workspace.mutate(name,{}),/Production inspection/);
 assert.deepEqual(calls,['duty_load','duty_load']);
});

test('central transport blocks GET and POST mutations, table writes and Auth onboarding',async()=>{
 const sent=[],fetcher=async request=>{sent.push(request.url);return new Response('{}');};
 const guarded=guardedFetch(PROJECTS.prod,resolveEnvironment(PROJECTS.prod,'http://localhost:5173'),fetcher);
 for(const [path,method] of [['/rest/v1/rpc/duty_join','POST'],['/rest/v1/rpc/duty_save_schedule','POST'],['/rest/v1/rpc/future_rpc','GET'],['/rest/v1/duty_members','PATCH'],['/rest/v1/duty_members','DELETE'],['/rest/v1/duty_members','POST'],['/auth/v1/signup','POST'],['/auth/v1/user','PUT']])await assert.rejects(guarded(PROJECTS.prod+path,{method}),/Production inspection/);
 assert.equal(sent.length,0);
 for(const [path,method] of [['/rest/v1/rpc/duty_load','POST'],['/rest/v1/duty_members','GET'],['/auth/v1/user','GET'],['/auth/v1/token','POST'],['/auth/v1/logout?scope=local','POST']])await guarded(PROJECTS.prod+path,{method});
 assert.equal(sent.length,5);
 await assert.rejects(guarded(PROJECTS.dev+'/rest/v1/rpc/duty_load'),/destination/);
});

test('inspection sign-out preserves unrelated Production refresh sessions',async()=>{
 for(const [origin,scope] of [['http://localhost:5173','local'],['https://duty-scheduler-prod.vercel.app','global']]){
  const client={auth:{signOut:async options=>{assert.deepEqual(options,{scope});return {error:null}}}};
  registerEnvironment(client,resolveEnvironment(PROJECTS.prod,origin));
  await signOutSafely(client);
 }
 const guarded=guardedFetch(PROJECTS.prod,resolveEnvironment(PROJECTS.prod,'http://localhost:5173'),async()=>new Response('{}'));
 for(const suffix of ['','?scope=global','?scope=others'])await assert.rejects(guarded(PROJECTS.prod+'/auth/v1/logout'+suffix,{method:'POST'}),/own session/);
});

test('deployed Production and Development retain checked writes',async()=>{
 for(const [url,origin] of [[PROJECTS.prod,'https://duty-scheduler-prod.vercel.app'],[PROJECTS.dev,'http://localhost:5173']]){
  let sent=0;
  await guardedFetch(url,resolveEnvironment(url,origin),async()=>{sent++;return new Response('{}')})(url+'/rest/v1/rpc/duty_join',{method:'POST'});
  assert.equal(sent,1);
 }
});
