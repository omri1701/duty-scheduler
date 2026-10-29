// Full isolated Auth/API stack. No links, hosted credentials or schema changes.
import {mkdirSync,readFileSync,writeFileSync,cpSync,readdirSync,existsSync,unlinkSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createClient} from '@supabase/supabase-js';
import {LOCAL_API_URL,connectionTarget,validatePublicKey} from '../lib/supabase/environment.ts';

const root=resolve(import.meta.dirname,'..'),directory=resolve(root,'work/local-supabase'),container='supabase_db_duty-scheduler-app';
const STALE_STACK='The LOCAL stack still uses old ports 58320–58324. Stop it once (data is kept): pnpm dlx supabase@2.119.0 stop --project-id duty-scheduler-app, then rerun.';
export const LOCAL_PASSWORD='Duty-local-only-1701!';
export const LOCAL_ACCOUNTS=[['admin@duty.local','Local Admin'],['engineer@duty.local','Local Engineer'],['pending@duty.local','Local Pending']];
// Fictional temporary members, in seniority order, for a 12-engineer LOCAL team.
export const LOCAL_TEMPORARY_MEMBERS=['Avi','Dana','Yossi','Noa','Eitan','Maya','Lior','Tamar','Omer','Shira'];
export const missingTemporaryMembers=members=>LOCAL_TEMPORARY_MEMBERS.filter(name=>!members.some(m=>m.name===name));
function cli(args,capture=false) {
  // pnpm scripts provide its executable path, avoiding shell quoting on Windows.
  if (!process.env.npm_execpath) throw Error('Run via pnpm local:setup or pnpm dev:local.');
  const native=process.env.npm_execpath.endsWith('.exe');
  try {return execFileSync(native?process.env.npm_execpath:process.execPath,[...(native?[]:[process.env.npm_execpath]),'dlx','supabase@2.119.0',...args,'--workdir',directory],{cwd:root,encoding:'utf8',stdio:capture?['ignore','pipe','pipe']:['ignore','ignore','pipe']});}
  catch {throw Error('Local Supabase command failed. Check Docker Desktop and available ports 48320–48324; run the documented local CLI command for diagnostics.');}
}
export async function prepareLocal() {
  mkdirSync(resolve(directory,'supabase'),{recursive:true});
  const config=readFileSync(resolve(root,'supabase/config.toml'),'utf8').replace('project_id = "duty-scheduler"','project_id = "duty-scheduler-app"').replaceAll('5432','4832');
  writeFileSync(resolve(directory,'supabase/config.toml'),config);
  const manifestFile=resolve(directory,'migrations.json');
  const source=readdirSync(resolve(root,'supabase/migrations')).filter(f=>f.endsWith('.sql')).sort();
  const hashes=Object.fromEntries(source.map(file=>[file,createHash('sha256').update(readFileSync(resolve(root,'supabase/migrations',file))).digest('hex')]));
  const previous=existsSync(manifestFile)?JSON.parse(readFileSync(manifestFile,'utf8')):{};
  const reset=process.argv.includes('--reset');
  if(Object.entries(previous).some(([file,hash])=>hashes[file]!==hash)&&!reset)throw Error('Local database belongs to different branch migrations. Run pnpm local:reset to discard only the isolated app database and replay the current branch.');
  const migrationDirectory=resolve(directory,'supabase/migrations');
  if(reset&&existsSync(migrationDirectory))for(const file of readdirSync(migrationDirectory).filter(f=>f.endsWith('.sql'))){
    const path=resolve(migrationDirectory,file);
    if(dirname(path)!==migrationDirectory)throw Error('Unsafe local migration path.');
    unlinkSync(path);
  }
  cpSync(resolve(root,'supabase/migrations'),resolve(directory,'supabase/migrations'),{recursive:true});
  // Refuse stale migrations after branch switching; never silently replay a
  // database from a different branch. Explicit local:reset recreates fixtures.
  const copied=readdirSync(resolve(directory,'supabase/migrations')).filter(f=>f.endsWith('.sql')).sort();
  if (JSON.stringify(source)!==JSON.stringify(copied)) throw Error('Stale branch migrations. Run pnpm local:reset to replay only the isolated app database.');
  // A stack started before the move out of Windows' dynamic port range keeps
  // its old ports; the CLI would report the new ones without restarting it.
  let ports='';
  try {ports=execFileSync('docker',['ps','--filter','name=supabase_kong_duty-scheduler-app','--format','{{.Ports}}'],{encoding:'utf8',stdio:['ignore','pipe','ignore']});} catch {}
  if (/:58321->/.test(ports)) throw Error(STALE_STACK);
  console.log('Starting isolated local Supabase Auth/API stack…');
  cli(['start','--exclude','logflare,vector,supavisor,edge-runtime,imgproxy,storage-api,realtime']);
  if(reset)cli(['db','reset','--local','--no-seed']);
  else cli(['migration','up','--local']);
  writeFileSync(manifestFile,JSON.stringify(hashes));
  const output=cli(['status','-o','json'],true);
  const status=JSON.parse(output.slice(output.indexOf('{'),output.lastIndexOf('}')+1));
  const env={SUPABASE_URL:status.API_URL,SUPABASE_PUBLISHABLE_KEY:status.PUBLISHABLE_KEY??status.ANON_KEY};
  if (connectionTarget(env.SUPABASE_URL)!=='local' || env.SUPABASE_URL!==LOCAL_API_URL) throw Error('Unexpected local API.');
  validatePublicKey(env.SUPABASE_URL,env.SUPABASE_PUBLISHABLE_KEY);
  const users=[];
  for (const [email,name] of LOCAL_ACCOUNTS) {
    const client=createClient(env.SUPABASE_URL,env.SUPABASE_PUBLISHABLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
    let signed=await client.auth.signInWithPassword({email,password:LOCAL_PASSWORD});
    let createdNow=false;
    if (signed.error) {
      const created=await client.auth.signUp({email,password:LOCAL_PASSWORD,options:{data:{full_name:name}}});
      if(created.error)throw Error('Could not create local test identity.');
      createdNow=true;
      signed=await client.auth.signInWithPassword({email,password:LOCAL_PASSWORD});
    }
    if(signed.error||!signed.data.user)throw Error('Local password authentication failed.');
    const joined=await client.rpc('duty_join',{p_name:name});
    if(joined.error)throw Error('Local onboarding failed.');
    users.push({client,id:signed.data.user.id,email,createdNow});
  }
  if(users.some(u=>!/^[-a-f0-9]{36}$/.test(u.id)))throw Error('Invalid local identity.');
  // Operator fixture approval is local-only; the app continues using public keys,
  // verified Auth identities, the real checked RPCs and unchanged RLS.
  const sql=`begin; select 1 from public.duty_workspace where id for update;
    update public.duty_members set status='approved',active=true,role=case when email='admin@duty.local' then 'admin' else 'engineer' end
    where id in ('${users[0].id}','${users[1].id}') and email in ('admin@duty.local','engineer@duty.local');
    update public.duty_workspace set revision=revision+1 where id; commit;`;
  execFileSync('docker',['exec','-i',container,'psql','-U','postgres','-q','-v','ON_ERROR_STOP=1'],{input:sql,stdio:['pipe','ignore','pipe']});
  // Reset adds the team through the admin's checked RPC with the current revision, like the app.
  if(reset){
    let loaded=await users[0].client.rpc('duty_load');
    if(loaded.error)throw Error('Local admin workspace load failed.');
    for(const name of missingTemporaryMembers(loaded.data.members)){
      const added=await users[0].client.rpc('duty_add_temporary_member',{p_name:name,p_revision:loaded.data.revision});
      if(added.error)throw Error('Local temporary member creation failed.');
      loaded=await users[0].client.rpc('duty_load');
      if(loaded.error)throw Error('Local admin workspace load failed.');
    }
    if(missingTemporaryMembers(loaded.data.members).length)throw Error('Local temporary members missing.');
  }
  for(const user of users){
    const loaded=await user.client.rpc('duty_load');
    if(loaded.error||!loaded.data?.members?.find(m=>m.id===user.id))throw Error('Local authenticated workspace load failed.');
    const me=loaded.data.members.find(m=>m.id===user.id);
    if(user.email==='pending@duty.local'&&user.createdNow&&(me.status!=='pending'||loaded.data.revision!==null))throw Error('Local pending membership permission check failed.');
    if(user.email!=='pending@duty.local'&&(me.status!=='approved'||!me.active||me.role!==(user.email==='admin@duty.local'?'admin':'engineer')))throw Error('Local approved account check failed.');
    const forbidden=await user.client.from('duty_members').update({role:'admin'}).eq('id',user.id);
    if(!forbidden.error)throw Error('Local direct table writes must be denied.');
    await user.client.auth.signOut({scope:'local'});
  }
  console.log('LOCAL authentication, checked onboarding, workspace loading and denied table writes verified.');
  return env;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)prepareLocal().then(()=>console.log(`Local accounts: admin@duty.local, engineer@duty.local, pending@duty.local. Password: Duty-local-only-1701!${process.argv.includes('--reset')?` Temporary members: ${LOCAL_TEMPORARY_MEMBERS.join(', ')}.`:''}`)).catch(error=>{console.error(error.message);process.exitCode=1;});
