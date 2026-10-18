import {existsSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {readDevelopmentEnv,selectConfiguration} from './dev-environment.mjs';
import {PROJECTS} from '../lib/supabase/environment.ts';
import {verifyServedCss} from './verify-served-css.mjs';

const children = new Set();
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) {
    if (!child.pid) continue;
    if (process.platform === 'win32') spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore'});
    else child.kill('SIGTERM');
  }
}
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>stop());
function start(command,args,options = {}) {
  const child = spawn(command,args,{stdio:'inherit',...options});
  children.add(child);
  child.on('error',()=>{console.error('Could not start mobile development process.');stop(1);});
  child.on('exit',code=>{children.delete(child);if (!stopping) stop(code ?? 1);});
  return child;
}
async function main() {
  const selected = selectConfiguration('dev',readDevelopmentEnv());
  if (!selected.DUTY_DEV_ORIGIN) throw Error('Set DUTY_DEV_ORIGIN to your static HTTPS ngrok origin in ignored .env.dev.local.');
  const config = resolve('work/ngrok/ngrok.yml');
  if (!existsSync(config)) throw Error('Authenticate ngrok locally with scripts/ngrok-auth.ps1 first (see Supabase setup).');
  // Do not accidentally tunnel an unrelated server already occupying this port.
  await new Promise((accept,reject)=>{
    const server = createServer();
    server.once('error',reject);
    server.listen(5173,'127.0.0.1',()=>server.close(accept));
  });
  // This is the existing pnpm dev:dev launcher, with its loopback/DEV safeguards.
  // Next dev logs request URLs, including OAuth callback codes. Keep its output
  // out of this mobile terminal; configuration readiness is verified below.
  start(process.execPath,['scripts/dev-environment.mjs','dev'],{env:{...process.env,...selected},stdio:'ignore'});
  let ready = false;
  for (let attempt = 0; attempt < 60 && !stopping; attempt++) {
    try {
      const response = await fetch('http://localhost:5173/api/config',{signal:AbortSignal.timeout(2000)});
      if (response.ok) {
        const config = await response.json();
        if (config.url !== PROJECTS.dev || config.devOrigin !== selected.DUTY_DEV_ORIGIN) throw Error('Unexpected DEV configuration.');
        ready = true;
        break;
      }
    } catch {}
    await delay(1000);
  }
  if (stopping) return;
  if (!ready) throw Error('Next.js DEV configuration did not become ready; tunnel was not started.');
  await verifyServedCss('http://localhost:5173',{attempts:30});
  const binary = existsSync('work/ngrok/ngrok.exe') ? resolve('work/ngrok/ngrok.exe') : 'ngrok';
  start(binary,['http','http://localhost:5173',`--url=${selected.DUTY_DEV_ORIGIN}`,`--config=${config}`,'--inspect=false','--log=false'],{stdio:'ignore'});
  console.log(`Mobile DEV: ${selected.DUTY_DEV_ORIGIN}\nKeep this terminal running. Ctrl+C stops Next.js and ngrok.`);
}
main().catch(error=>{console.error(error.message);stop(1);});
