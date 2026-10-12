import {readFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {createInterface} from 'node:readline/promises';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {PROJECTS,connectionTarget,validatePublicKey} from '../lib/supabase/environment.ts';

export function selectConfiguration(mode, env, productionConfirmed = false) {
  if (!['local','dev','prod'].includes(mode)) throw Error('Select local, dev or prod.');
  if (mode === 'prod' && !productionConfirmed) throw Error('Production inspection requires explicit confirmation every time.');
  const url = mode === 'prod' ? PROJECTS.prod : env.SUPABASE_URL;
  const key = mode === 'prod' ? env.SUPABASE_PROD_PUBLISHABLE_KEY : env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key || connectionTarget(url) !== mode) throw Error(`Missing or mismatched ${mode.toUpperCase()} configuration.`);
  validatePublicKey(url,key);
  return {SUPABASE_URL:url,SUPABASE_PUBLISHABLE_KEY:key,DUTY_SUPABASE_TARGET:mode,DUTY_PRODUCTION_INSPECTION:mode==='prod'?'confirmed':''};
}
function readEnv(file) {
  try {return parseEnv(readFileSync(file,'utf8'));}
  catch (error) {if (error.code === 'ENOENT') return {}; throw error;}
}
async function main() {
  let mode = process.argv[2] ?? 'dev';
  if (mode === 'select') {
    if (!process.stdin.isTTY) throw Error('The selector requires an interactive terminal.');
    const prompt = createInterface({input:process.stdin,output:process.stdout});
    try {mode=(await prompt.question('Supabase target [dev/local/prod] (dev): ')).trim().toLowerCase()||'dev';}
    finally {prompt.close();}
  }
  let confirmed = false;
  if (mode === 'prod') {
    if (!process.stdin.isTTY) throw Error('Production inspection requires an interactive terminal; confirmation cannot be automated.');
    const prompt = createInterface({input:process.stdin,output:process.stdout});
    try {confirmed=(await prompt.question('PRODUCTION: application read-only safeguard only. Type INSPECT PRODUCTION to continue: '))==='INSPECT PRODUCTION';}
    finally {prompt.close();}
  }
  let env;
  if (mode === 'local') {
    const {prepareLocal} = await import('./local-supabase.mjs');
    env = await prepareLocal();
  } else if (mode === 'dev') env = {...readEnv('.env.local'),...readEnv('.env.dev.local'),...process.env};
  else env = {...readEnv('.env.prod.local'),...process.env};
  const selected = selectConfiguration(mode,env,confirmed);
  console.log(`Duty: ${mode.toUpperCase()}${mode==='prod'?' · application read-only inspection':''} at http://localhost:5173`);
  const child=spawn(process.execPath,['node_modules/next/dist/bin/next','dev','--hostname','127.0.0.1','--port','5173'],{stdio:'inherit',env:{...process.env,...selected}});
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>child.kill(signal));
  child.on('error',()=>{console.error('Could not start Next.js.');process.exitCode=1;});
  child.on('exit',code=>{process.exitCode=code??1;});
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error=>{console.error(error.message);process.exitCode=1;});
