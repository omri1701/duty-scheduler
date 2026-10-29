import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {PROJECTS,LOCAL_API_URL,resolveEnvironment,validatePublicKey,validateDevOrigin,configuredDevOrigin,configuredLocalTunnel} from '../lib/supabase/environment.ts';
import {selectConfiguration} from '../scripts/dev-environment.mjs';

test('all five display cases derive from the project URL and runtime origin',()=>{
 for(const [url,origin,badge,readOnly] of [
  ['http://127.0.0.1:48321','http://localhost:5173','LOCAL',false],
  [PROJECTS.dev,'http://localhost:5173','DEV',false],
  [PROJECTS.dev,'https://duty-scheduler-dev.vercel.app','DEV',false],
  [PROJECTS.prod,'http://localhost:5173','PROD',true],
  [PROJECTS.prod,'https://duty-scheduler-prod.vercel.app',null,false],
 ]){const result=resolveEnvironment(url,origin);assert.equal(result.badge,badge);assert.equal(result.readOnly,readOnly);}
});

test('unknown projects, unsafe URLs and mismatched hosting fail closed',()=>{
 for(const [url,origin] of [
  ['https://unknown.supabase.co','http://localhost:5173'],
  [PROJECTS.prod,'https://duty-scheduler-dev.vercel.app'],
  [PROJECTS.dev,'https://duty-scheduler-prod.vercel.app'],
  ['http://127.0.0.1:48321','https://duty-scheduler-dev.vercel.app'],
  [PROJECTS.dev,'https://unknown.example'],
  [PROJECTS.prod,'http://host.docker.internal:8787'],
  [PROJECTS.dev+'/bad','http://localhost:5173'],
  [PROJECTS.dev.replace('https://','https://user:password@'),'http://localhost:5173'],
 ])assert.throws(()=>resolveEnvironment(url,origin));
 assert.equal(resolveEnvironment(PROJECTS.dev,'https://duty-preview.vercel.app','https://duty-preview.vercel.app').badge,'DEV');
 assert.throws(()=>resolveEnvironment(PROJECTS.prod,'https://unknown.vercel.app'));
 assert.equal(resolveEnvironment(PROJECTS.prod,'https://duty-production-immutable.vercel.app','https://duty-production-immutable.vercel.app').badge,null);
 assert.throws(()=>resolveEnvironment(PROJECTS.prod,'https://duty-scheduler-dev.vercel.app','https://duty-scheduler-dev.vercel.app'));
});

test('mode selection rejects mismatches and requires fresh Production confirmation',()=>{
 const env={SUPABASE_URL:PROJECTS.dev,SUPABASE_PUBLISHABLE_KEY:'sb_publishable_synthetic',SUPABASE_PROD_PUBLISHABLE_KEY:'sb_publishable_synthetic_prod'};
 assert.equal(selectConfiguration('dev',env).SUPABASE_URL,PROJECTS.dev);
 assert.throws(()=>selectConfiguration('local',env),/mismatched/);
 assert.throws(()=>selectConfiguration('unknown',env),/Select/);
 assert.throws(()=>selectConfiguration('prod',env),/confirmation/);
 assert.equal(selectConfiguration('prod',env,true).DUTY_PRODUCTION_INSPECTION,'confirmed');
 assert.throws(()=>selectConfiguration('prod',env),/confirmation/);
 assert.throws(()=>selectConfiguration('prod',{...env,SUPABASE_PROD_PUBLISHABLE_KEY:undefined},true),/Missing/);
 assert.equal(selectConfiguration('local',{SUPABASE_URL:'http://127.0.0.1:48321',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_local'}).DUTY_SUPABASE_TARGET,'local');
});

test('Production launcher refuses unattended selection even with a supplied key or old confirmation',()=>{
 const child=spawnSync(process.execPath,['scripts/dev-environment.mjs','prod'],{encoding:'utf8',env:{...process.env,SUPABASE_PROD_PUBLISHABLE_KEY:'sb_publishable_synthetic',DUTY_PRODUCTION_INSPECTION:'confirmed'}});
 assert.equal(child.status,1);
 assert.match(child.stderr,/requires an interactive terminal/);
 assert.doesNotMatch(child.stdout,/http:\/\/localhost/);
});

test('only local CLI anon JWTs and publishable keys are public configuration',()=>{
 const jwt=role=>['eyJhbGciOiJIUzI1NiJ9',Buffer.from(JSON.stringify({role,iss:'supabase-demo'})).toString('base64url'),'synthetic'].join('.');
 validatePublicKey('http://127.0.0.1:48321',jwt('anon'));
 validatePublicKey(PROJECTS.dev,'sb_publishable_synthetic');
 for(const key of [jwt('service_role'),'sb_secret_synthetic','legacy-anon-jwt','sb_publishable_'])assert.throws(()=>validatePublicKey('http://127.0.0.1:48321',key));
 assert.throws(()=>validatePublicKey(PROJECTS.dev,jwt('anon')));
});

test('switching projects and local ports isolates sessions and PKCE storage',()=>{
 const urls=[PROJECTS.dev,PROJECTS.prod,'http://127.0.0.1:48321','http://127.0.0.1:48331'];
 assert.equal(new Set(urls.map(url=>resolveEnvironment(url,'http://localhost:5173').storageKey)).size,urls.length);
});

test('only the exact configured HTTPS ngrok origin can select DEV',()=>{
 const origin='https://synthetic-device.ngrok-free.app';
 assert.equal(validateDevOrigin(origin+'/'),origin);
 assert.equal(resolveEnvironment(PROJECTS.dev,origin,undefined,origin).badge,'DEV');
 assert.equal(resolveEnvironment(PROJECTS.dev,origin,undefined,origin).storageKey,resolveEnvironment(PROJECTS.dev,'http://localhost:5173').storageKey);
 for(const [url,runtime,configured] of [
  [PROJECTS.dev,origin,undefined],
  [PROJECTS.dev,'https://other-device.ngrok-free.app',origin],
  [PROJECTS.dev,origin.replace('https:','http:'),origin],
  [PROJECTS.dev,origin+':444',origin],
  [PROJECTS.prod,origin,origin],
  ['http://127.0.0.1:48321',origin,origin],
 ]) assert.throws(()=>resolveEnvironment(url,runtime,undefined,configured));
 for(const invalid of ['http://synthetic-device.ngrok-free.app',origin+':444',origin+'/path',origin+'?query=1',origin+'#fragment',origin.replace('https://','https://user@'),'https://*.ngrok-free.app','https://ngrok-free.app','https://synthetic-device.ngrok-free.app.evil.example','https://unknown.example']) assert.throws(()=>validateDevOrigin(invalid));
 const env={NODE_ENV:'development',SUPABASE_URL:PROJECTS.dev,DUTY_SUPABASE_TARGET:'dev',DUTY_DEV_ORIGIN:origin};
 assert.equal(configuredDevOrigin(env),origin);
 for(const extra of [{NODE_ENV:'production'},{DUTY_SUPABASE_TARGET:'prod'},{DUTY_SUPABASE_TARGET:'local'},{DUTY_SUPABASE_TARGET:undefined},{SUPABASE_URL:PROJECTS.prod},{VERCEL_ENV:'development'},{VERCEL_URL:'preview.vercel.app'}]) assert.equal(configuredDevOrigin({...env,...extra}),undefined);
 const keys={SUPABASE_URL:PROJECTS.dev,SUPABASE_PUBLISHABLE_KEY:'sb_publishable_synthetic',SUPABASE_PROD_PUBLISHABLE_KEY:'sb_publishable_prod',DUTY_DEV_ORIGIN:origin};
 assert.equal(selectConfiguration('dev',keys).DUTY_DEV_ORIGIN,origin);
 assert.equal(selectConfiguration('prod',keys,true).DUTY_DEV_ORIGIN,'');
 assert.equal(selectConfiguration('local',{...keys,SUPABASE_URL:'http://127.0.0.1:48321'}).DUTY_DEV_ORIGIN,'');
});

test('the LOCAL phone proxy fails closed outside next dev with the explicit LOCAL loopback target',()=>{
 const origin='https://synthetic-device.ngrok-free.app';
 const env={NODE_ENV:'development',SUPABASE_URL:LOCAL_API_URL,DUTY_SUPABASE_TARGET:'local',DUTY_LOCAL_TUNNEL_ORIGIN:origin};
 assert.deepEqual(configuredLocalTunnel(env),{origin,api:LOCAL_API_URL});
 for(const extra of [
  {NODE_ENV:'production'},{NODE_ENV:undefined},{VERCEL:'1'},{VERCEL_ENV:'development'},{VERCEL_URL:'preview.vercel.app'},
  {DUTY_SUPABASE_TARGET:'dev'},{DUTY_SUPABASE_TARGET:'prod'},{DUTY_SUPABASE_TARGET:undefined},
  {SUPABASE_URL:PROJECTS.dev},{SUPABASE_URL:PROJECTS.prod},{SUPABASE_URL:'http://localhost:48321'},{SUPABASE_URL:'http://192.168.1.5:48321'},
  {SUPABASE_URL:'https://unknown.example'},{SUPABASE_URL:undefined},
  {DUTY_DEV_ORIGIN:origin},{DUTY_PRODUCTION_INSPECTION:'confirmed'},
  {DUTY_LOCAL_TUNNEL_ORIGIN:undefined},{DUTY_LOCAL_TUNNEL_ORIGIN:'https://evil.example'},{DUTY_LOCAL_TUNNEL_ORIGIN:origin.replace('https:','http:')},
 ]) assert.equal(configuredLocalTunnel({...env,...extra}),undefined,JSON.stringify(extra));
 // DEV's tunnel setting cannot enable the LOCAL proxy, nor the reverse.
 assert.equal(configuredLocalTunnel({...env,DUTY_LOCAL_TUNNEL_ORIGIN:undefined,DUTY_DEV_ORIGIN:origin}),undefined);
 assert.equal(configuredDevOrigin({...env,SUPABASE_URL:PROJECTS.dev,DUTY_SUPABASE_TARGET:'dev'}),undefined);
 assert.equal(resolveEnvironment(LOCAL_API_URL,origin,undefined,undefined,origin).badge,'LOCAL');
 assert.equal(resolveEnvironment(LOCAL_API_URL,origin,undefined,undefined,origin).storageKey,resolveEnvironment(LOCAL_API_URL,'http://localhost:5173').storageKey);
 for(const [url,runtime] of [[PROJECTS.dev,origin],[PROJECTS.prod,origin],[LOCAL_API_URL,'https://other-device.ngrok-free.app']]) assert.throws(()=>resolveEnvironment(url,runtime,undefined,undefined,origin));
 const local={SUPABASE_URL:LOCAL_API_URL,SUPABASE_PUBLISHABLE_KEY:'sb_publishable_local',DUTY_LOCAL_TUNNEL_ORIGIN:origin};
 assert.equal(selectConfiguration('local',local).DUTY_LOCAL_TUNNEL_ORIGIN,origin);
 assert.equal(selectConfiguration('dev',{...local,SUPABASE_URL:PROJECTS.dev}).DUTY_LOCAL_TUNNEL_ORIGIN,'');
 assert.throws(()=>selectConfiguration('local',{...local,DUTY_LOCAL_TUNNEL_ORIGIN:'https://evil.example'}));
});
