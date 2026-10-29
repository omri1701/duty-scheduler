import test from 'node:test';
import assert from 'node:assert/strict';
import {GET,dynamic} from '../app/api/config/route.ts';
import {PROJECTS,LOCAL_API_URL} from '../lib/supabase/environment.ts';

test('runtime config validates project, public key, origin, mode and inspection confirmation; never caches',async()=>{
 const names=['SUPABASE_URL','SUPABASE_PUBLISHABLE_KEY','DUTY_SUPABASE_TARGET','DUTY_PRODUCTION_INSPECTION','VERCEL_ENV','VERCEL_URL','NODE_ENV','DUTY_DEV_ORIGIN'];
 const original=Object.fromEntries(names.map(name=>[name,process.env[name]]));
 try {
  assert.equal(dynamic,'force-dynamic');
  for(const [url,key,origin,extra,status] of [
   [undefined,undefined,'http://localhost:5173',{},503],
   [PROJECTS.dev,'sb_secret_synthetic','http://localhost:5173',{},503],
   ['https://unknown.supabase.co','sb_publishable_synthetic','http://localhost:5173',{},503],
   [PROJECTS.dev,'sb_publishable_synthetic','http://localhost:5173',{},200],
   [PROJECTS.dev,'sb_publishable_synthetic','http://localhost:5173',{DUTY_SUPABASE_TARGET:'prod'},503],
   [PROJECTS.prod,'sb_publishable_synthetic','http://localhost:5173',{},503],
   [PROJECTS.prod,'sb_publishable_synthetic','http://localhost:5173',{DUTY_PRODUCTION_INSPECTION:'confirmed',DUTY_SUPABASE_TARGET:'prod'},200],
   [PROJECTS.prod,'sb_publishable_synthetic','https://duty-scheduler-dev.vercel.app',{},503],
   [PROJECTS.prod,'sb_publishable_synthetic','https://duty-scheduler-prod.vercel.app',{VERCEL_ENV:'production'},200],
   [PROJECTS.prod,'sb_publishable_synthetic','https://duty-scheduler-prod.vercel.app',{VERCEL_ENV:'preview'},503],
   [PROJECTS.prod,'sb_publishable_synthetic','https://duty-production-immutable.vercel.app',{VERCEL_ENV:'production',VERCEL_URL:'duty-production-immutable.vercel.app'},200],
   [PROJECTS.prod,'sb_publishable_synthetic','https://duty-production-immutable.vercel.app',{VERCEL_ENV:'preview',VERCEL_URL:'duty-production-immutable.vercel.app'},503],
   [PROJECTS.dev,'sb_publishable_synthetic','https://duty-preview.vercel.app',{VERCEL_ENV:'preview',VERCEL_URL:'duty-preview.vercel.app'},200],
   ['http://127.0.0.1:48321','sb_publishable_local','http://localhost:5173',{DUTY_SUPABASE_TARGET:'local'},200],
  ]){
   for(const name of names)delete process.env[name];
   if(url)process.env.SUPABASE_URL=url;
   if(key)process.env.SUPABASE_PUBLISHABLE_KEY=key;
   Object.assign(process.env,extra);
   const response=await GET(new Request(origin+'/api/config'));
   assert.equal(response.status,status,`${url} at ${origin}`);
   assert.equal(response.headers.get('cache-control'),'no-store');
   const json=await response.json();
   assert.deepEqual(json,status===200?{url,key,...(extra.VERCEL_URL?{deploymentOrigin:'https://'+extra.VERCEL_URL}:{})}:{error:'Not configured'});
  }
 }finally{for(const name of names){if(original[name]===undefined)delete process.env[name];else process.env[name]=original[name];}}
});

test('mobile config trusts only its explicit DEV proxy and stays disabled in Production/hosting',async()=>{
 const names=['SUPABASE_URL','SUPABASE_PUBLISHABLE_KEY','DUTY_SUPABASE_TARGET','DUTY_PRODUCTION_INSPECTION','VERCEL_ENV','VERCEL_URL','NODE_ENV','DUTY_DEV_ORIGIN'];
 const original=Object.fromEntries(names.map(name=>[name,process.env[name]]));
 const origin='https://synthetic-device.ngrok-free.app';
 const host=new URL(origin).host;
 try {
  for(const [requestOrigin,headers,extra,status] of [
   [origin,{}, {},200],
   [origin,{host,'x-forwarded-proto':'http'},{},503],
   ['https://127.0.0.1:5173',{host,'x-forwarded-host':host,'x-forwarded-proto':'https'},{},200],
   ['http://localhost:5173',{}, {},200],
   ['http://127.0.0.1:5173',{host:'localhost:5173','x-forwarded-host':'localhost:5173','x-forwarded-proto':'http'},{},200],
   ['https://127.0.0.1:5173',{host,'x-forwarded-proto':'https'},{},200],
   ['https://127.0.0.1:5173',{host,'x-forwarded-proto':'http'},{},503],
   ['https://127.0.0.1:5173',{host,'x-forwarded-proto':'https,http'},{},503],
   ['https://127.0.0.1:5173',{host:'other.ngrok-free.app','x-forwarded-proto':'https'},{},503],
   ['https://127.0.0.1:5173',{host,'x-forwarded-host':'other.ngrok-free.app','x-forwarded-proto':'https'},{},503],
   ['https://other.ngrok-free.app',{}, {},503],
   [origin,{}, {NODE_ENV:'production'},503],
   [origin,{}, {VERCEL_ENV:'development'},503],
   [origin,{}, {DUTY_SUPABASE_TARGET:'local'},503],
   [origin,{}, {SUPABASE_URL:PROJECTS.prod,DUTY_SUPABASE_TARGET:'prod',DUTY_PRODUCTION_INSPECTION:'confirmed'},503],
   ['https://duty-scheduler-dev.vercel.app',{}, {VERCEL_ENV:'preview'},200],
   ['https://duty-scheduler-prod.vercel.app',{}, {NODE_ENV:'production',VERCEL_ENV:'production',SUPABASE_URL:PROJECTS.prod,DUTY_SUPABASE_TARGET:'prod'},200],
  ]) {
   for(const name of names)delete process.env[name];
   Object.assign(process.env,{SUPABASE_URL:PROJECTS.dev,SUPABASE_PUBLISHABLE_KEY:'sb_publishable_synthetic',DUTY_SUPABASE_TARGET:'dev',NODE_ENV:'development',DUTY_DEV_ORIGIN:origin},extra);
   const response=await GET(new Request(requestOrigin+'/api/config',{headers}));
   assert.equal(response.status,status,JSON.stringify([requestOrigin,headers,extra]));
   const body=await response.json();
   if(status===200) {
    assert.equal(body.url,process.env.SUPABASE_URL);
    assert.equal(body.devOrigin,extra.NODE_ENV==='production'||extra.VERCEL_ENV?undefined:origin);
   }
  }
 }finally{for(const name of names){if(original[name]===undefined)delete process.env[name];else process.env[name]=original[name];}}
});

test('LOCAL phone config returns the loopback API only with its explicit LOCAL tunnel',async()=>{
 const names=['SUPABASE_URL','SUPABASE_PUBLISHABLE_KEY','DUTY_SUPABASE_TARGET','DUTY_PRODUCTION_INSPECTION','VERCEL','VERCEL_ENV','VERCEL_URL','NODE_ENV','DUTY_DEV_ORIGIN','DUTY_LOCAL_TUNNEL_ORIGIN'];
 const original=Object.fromEntries(names.map(name=>[name,process.env[name]]));
 const origin='https://synthetic-device.ngrok-free.app';
 const host=new URL(origin).host;
 try {
  for(const [requestOrigin,headers,extra,status] of [
   [origin,{}, {},200],
   ['https://127.0.0.1:5173',{host,'x-forwarded-proto':'https'},{},200],
   ['http://localhost:5173',{}, {},200],
   ['https://127.0.0.1:5173',{host,'x-forwarded-proto':'http'},{},503],
   ['https://other.ngrok-free.app',{}, {},503],
   [origin,{}, {NODE_ENV:'production'},503],
   [origin,{}, {VERCEL_ENV:'development'},503],
   [origin,{}, {DUTY_SUPABASE_TARGET:'dev'},503],
   [origin,{}, {DUTY_LOCAL_TUNNEL_ORIGIN:undefined,DUTY_DEV_ORIGIN:origin},503],
  ]) {
   for(const name of names)delete process.env[name];
   Object.assign(process.env,{SUPABASE_URL:LOCAL_API_URL,SUPABASE_PUBLISHABLE_KEY:'sb_publishable_local',DUTY_SUPABASE_TARGET:'local',NODE_ENV:'development',DUTY_LOCAL_TUNNEL_ORIGIN:origin},extra);
   for(const name of names)if(process.env[name]==='undefined')delete process.env[name];
   const response=await GET(new Request(requestOrigin+'/api/config',{headers}));
   assert.equal(response.status,status,JSON.stringify([requestOrigin,headers,extra]));
   if(status===200)assert.deepEqual(await response.json(),{url:LOCAL_API_URL,key:'sb_publishable_local',localTunnel:origin});
  }
 }finally{for(const name of names){if(original[name]===undefined)delete process.env[name];else process.env[name]=original[name];}}
});
