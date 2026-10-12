import test from 'node:test';
import assert from 'node:assert/strict';
import {GET,dynamic} from '../app/api/config/route.ts';
import {PROJECTS} from '../lib/supabase/environment.ts';

test('runtime config validates project, public key, origin, mode and inspection confirmation; never caches',async()=>{
 const names=['SUPABASE_URL','SUPABASE_PUBLISHABLE_KEY','DUTY_SUPABASE_TARGET','DUTY_PRODUCTION_INSPECTION','VERCEL_ENV','VERCEL_URL'];
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
   ['http://127.0.0.1:58321','sb_publishable_local','http://localhost:5173',{DUTY_SUPABASE_TARGET:'local'},200],
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
