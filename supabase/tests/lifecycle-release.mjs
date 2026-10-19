// Rehearse both already-applied DEV and pending Production paths, entirely LOCAL.
import assert from 'node:assert/strict';
import {mkdtemp,cp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {exportContract,historyQuery,verifyHistory} from '../../scripts/database-contract.mjs';
import {releaseDatabaseFirst} from '../../scripts/release.mjs';
import {manager,seed,snapshot} from './lifecycle-fixture.mjs';

const container=process.argv[2];
assert.match(container??'',/^supabase_db_[\w-]+$/);
const configFile=path.join(process.env.SUPABASE_WORKDIR||'.','supabase/config.toml');
const localConfig=await readFile(configFile,'utf8');
const localProject=/^project_id\s*=\s*"([\w-]+)"\s*$/m.exec(localConfig)?.[1];
assert(localProject,'Missing local project identity');
assert.equal(container,`supabase_db_${localProject}`,'Local config must match inspected container before any reset/push');
const cli=process.env.SUPABASE_CLI||'supabase';
const run=(command,args,input)=>{
 const result=spawnSync(command,args,{input,encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
 return result.stdout.trim();
};
const query=sql=>run('docker',['exec','-i',container,'psql','-XqAt','-U','postgres','-v','ON_ERROR_STOP=1'],sql);
assert.equal(query('select count(*) from auth.users'),'0','Requires an empty disposable LOCAL database');
assert.equal(query('select count(*) from public.duty_members'),'0','Requires an empty disposable LOCAL database');
const directory=await mkdtemp(path.join(tmpdir(),'duty-lifecycle-release-'));
assert(path.resolve(directory).startsWith(path.resolve(tmpdir())+path.sep));
let reset=false;
try {
 await cp(configFile,path.join(directory,'supabase/config.toml'),{recursive:true});
 await cp('supabase/migrations',path.join(directory,'supabase/migrations'),{recursive:true});
 const contract=await exportContract(query,'a'.repeat(40),path.join(directory,'contract.json'));
 assert.deepEqual(contract.migrations.slice(2,5).map(([v])=>v),['20261017185214','20261017211958','20261018183148']);
 const fingerprintSQL=await readFile('supabase/tests/fingerprint.sql','utf8');
 const resetTo=version=>run(cli,['db','reset','--local','--no-seed','--yes','--workdir',directory,...(version?['--version',version]:[])]);
 reset=true;
 resetTo(contract.migrations[1][0]);
 query(`begin;${seed}commit;`);
 const before=JSON.parse(query(snapshot));
 const oldRPCs=JSON.parse(query(`select jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_object('args',p.proargnames,'result',pg_get_function_result(p.oid))) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'duty_%'`));
 const expected={...before,duties:JSON.parse(query(`select jsonb_agg(to_jsonb(a) order by id) from public.duty_assignments a where publication_id is not null or not exists(select 1 from public.duty_months m where m.status='published' and m.month=duty_private.duty_owner(a.day))`)),revision:before.revision+1};
 // Friday 31 December owns split Saturday 1 January, independently of row span.
 const assertData=()=>assert.deepEqual(JSON.parse(query(snapshot)),expected,'Only redundant published working rows and revision may change');
 let pushes=0,deployments=0;
 const push=dryRun=>{
  pushes++;
  assert.equal(deployments,0,'Application cannot deploy before migration');
  assert.deepEqual(verifyHistory(query(historyQuery),contract.migrations),contract.migrations.slice(2).map(([v])=>v));
  run(cli,['db','push','--local','--skip-vault','--yes','--workdir',directory,...(dryRun?['--dry-run']:[])]);
 };
 await releaseDatabaseFirst({query,push,contract,fingerprintSQL,deployApplication:()=>{
  assertData();
  assert.deepEqual(verifyHistory(query(historyQuery),contract.migrations,true),[]);
  deployments++;
 }});
 assert.equal(pushes,2,'Pending release must run CLI dry-run and one actual push');
 assert.equal(deployments,1);
 for(const [signature,definition] of Object.entries(oldRPCs)){
  assert.deepEqual(JSON.parse(query(`select jsonb_build_object('args',proargnames,'result',pg_get_function_result(oid)) from pg_proc where oid='${signature}'::regprocedure`)),definition,'Existing public RPC signature changed');
 }
 console.log('PASS: pending Production simulation applies the exact three versions once, before the application; populated upgrade equals fresh schema/RLS/grants and preserves drafts, publications, requests and Friday-owned boundaries');

 // Same path used when develop encounters migrations already installed on DEV.
 const afterHistory=query(historyQuery);
 const noPush=()=>assert.fail('Already-applied migrations must never execute again');
 await releaseDatabaseFirst({query,push:noPush,contract,fingerprintSQL,deployApplication:()=>{assertData();deployments++;}});
 assert.equal(query(historyQuery),afterHistory);
 assert.equal(deployments,2);
 console.log('PASS: already-applied Development simulation skips all three migrations and verifies the same contract without changing data/history');
 await assert.rejects(releaseDatabaseFirst({query,push:noPush,contract:{...contract,fingerprint:'wrong'},fingerprintSQL,deployApplication:()=>assert.fail('Contract failure deployed application')}),/contract mismatch/);

 // Reproduce the deployed client's old status-toggle Reopen against the new RPC.
 query(`begin;
 select set_config('request.jwt.claim.sub','${manager}',true);
 do $$begin
  begin
   perform public.duty_save_schedule('{"team":[],"months":{"2027-12":{"status":"draft","deadline":"2027-11-24","generated":true}},"duties":[]}'::jsonb,${expected.revision},null);
   raise exception 'Legacy Reopen unexpectedly succeeded';
  exception when raise_exception then if sqlerrm<>'Reopen the draft first' then raise;end if;end;
 end$$;
 rollback;`);
 assertData();
 console.log('PASS: legacy Reopen is incompatible and refuses atomically; hosted cutover must remain blocked until client compatibility is addressed');

 // Schema-only forward repair: restore exact routine definitions, preserve ACLs
 // and operational data/history. This cannot restore deleted working data.
 const routines=query(`select string_agg(pg_get_functiondef(p.oid)||';',E'\n' order by n.nspname,p.proname) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='duty_private' or n.nspname='public' and p.proname like 'duty_%'`);
 query(`begin;
 create or replace function duty_private.cancel_draft(p_month text,p_revision bigint) returns void language plpgsql security definer set search_path='' as $$begin raise exception 'Synthetic schema fault';end$$;
 ${routines}
 commit;`);
 assert.equal(query(fingerprintSQL),contract.fingerprint,'Schema-only repair changed catalog/security contract');
 assert.equal(query(historyQuery),afterHistory,'Schema-only repair changed migration history');
 assertData();
 console.log('PASS: schema-only routine repair restores exact catalog/security contract without operational row exports, data edits or migration-history repair');
} finally {
 if(reset)run(cli,['db','reset','--local','--no-seed','--yes','--workdir',directory]);
 await rm(directory,{recursive:true,force:true});
}
console.log('PASS: disposable LOCAL fixtures removed and final migration schema restored');
