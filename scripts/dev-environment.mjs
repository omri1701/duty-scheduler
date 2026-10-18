import {readFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {createInterface} from 'node:readline/promises';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {PROJECTS,connectionTarget,validatePublicKey,validateDevOrigin} from '../lib/supabase/environment.ts';
import {verifyServedCss} from './verify-served-css.mjs';

export function selectConfiguration(mode, env, productionConfirmed = false) {
  if (!['local','dev','prod'].includes(mode)) throw Error('Select local, dev or prod.');
  if (mode === 'prod' && !productionConfirmed) throw Error('Production inspection requires explicit confirmation every time.');
  const url = mode === 'prod' ? PROJECTS.prod : env.SUPABASE_URL;
  const key = mode === 'prod' ? env.SUPABASE_PROD_PUBLISHABLE_KEY : env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key || connectionTarget(url) !== mode) throw Error(`Missing or mismatched ${mode.toUpperCase()} configuration.`);
  validatePublicKey(url,key);
  return {SUPABASE_URL:url,SUPABASE_PUBLISHABLE_KEY:key,DUTY_SUPABASE_TARGET:mode,DUTY_PRODUCTION_INSPECTION:mode==='prod'?'confirmed':'',DUTY_DEV_ORIGIN:mode==='dev'&&env.DUTY_DEV_ORIGIN?validateDevOrigin(env.DUTY_DEV_ORIGIN):''};
}
function readEnv(file) {
  try {return parseEnv(readFileSync(file,'utf8'));}
  catch (error) {if (error.code === 'ENOENT') return {}; throw error;}
}
export function readDevelopmentEnv() {return {...readEnv('.env.local'),...readEnv('.env.dev.local'),...process.env};}
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
  } else if (mode === 'dev') env = readDevelopmentEnv();
  else env = {...readEnv('.env.prod.local'),...process.env};
  const selected = selectConfiguration(mode,env,confirmed);
  console.log(`Duty: ${mode.toUpperCase()}${mode==='prod'?' · application read-only inspection':''} at http://localhost:5173`);
  const child=spawn(process.execPath,['node_modules/next/dist/bin/next','dev','--hostname','127.0.0.1','--port','5173'],{stdio:'inherit',env:{...process.env,...selected}});
  let failed=false;
  const stop=(signal='SIGTERM')=>{
    // Next's CLI owns a server subprocess on Windows; terminate the owned tree.
    if(process.platform==='win32'&&child.pid)spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});
    else child.kill(signal);
  };
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>stop(signal));
  child.on('error',()=>{console.error('Could not start Next.js.');process.exitCode=1;});
  child.on('exit',code=>{if(!failed)process.exitCode=code??1;});
  try {
    await verifyServedCss('http://127.0.0.1:5173', {attempts:120});
    console.log('Served CSS matches the current source.');
  } catch(error) {
    failed=true;
    stop();
    throw error;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error=>{console.error(error.message);process.exitCode=1;});
