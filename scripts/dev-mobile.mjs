import {existsSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {readDevelopmentEnv,selectConfiguration} from './dev-environment.mjs';
import {PROJECTS,LOCAL_API_URL,validateDevOrigin} from '../lib/supabase/environment.ts';
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
  const local = process.argv[2] === 'local';
  if (process.argv[2] && !local) throw Error('Use pnpm dev:mobile or pnpm dev:mobile:local.');
  const development = readDevelopmentEnv();
  // LOCAL needs only the tunnel origin; DEV keeps its full DEV selection.
  const selected = local ? {} : selectConfiguration('dev',development);
  const origin = local ? development.DUTY_DEV_ORIGIN && validateDevOrigin(development.DUTY_DEV_ORIGIN) : selected.DUTY_DEV_ORIGIN;
  if (!origin) throw Error('Set DUTY_DEV_ORIGIN to your static HTTPS ngrok origin in ignored .env.dev.local.');
  const config = resolve('work/ngrok/ngrok.yml');
  if (!existsSync(config)) throw Error('Authenticate ngrok locally with scripts/ngrok-auth.ps1 first (see Supabase setup).');
  // Do not accidentally tunnel an unrelated server already occupying this port.
  await new Promise((accept,reject)=>{
    const server = createServer();
    server.once('error',reject);
    server.listen(5173,'127.0.0.1',()=>server.close(accept));
  });
  if (local) {
    // The existing pnpm dev:local launcher (Docker setup, loopback API, CSS check),
    // plus the LOCAL-only same-origin Auth/REST proxy. Its output shows setup
    // progress; password sign-in puts no secrets in request URLs.
    start(process.execPath,['scripts/dev-environment.mjs','local'],{env:{...process.env,DUTY_DEV_ORIGIN:'',DUTY_LOCAL_TUNNEL_ORIGIN:origin}});
  } else {
    // This is the existing pnpm dev:dev launcher, with its loopback/DEV safeguards.
    // Next dev logs request URLs, including OAuth callback codes. Keep its output
    // out of this mobile terminal; configuration readiness is verified below.
    start(process.execPath,['scripts/dev-environment.mjs','dev'],{env:{...process.env,...selected},stdio:'ignore'});
  }
  let ready = false;
  // LOCAL first starts Docker services and verifies test accounts.
  for (let attempt = 0; attempt < (local ? 600 : 60) && !stopping; attempt++) {
    try {
      const response = await fetch('http://localhost:5173/api/config',{signal:AbortSignal.timeout(2000)});
      if (response.ok) {
        const config = await response.json();
        if (local) {
          if (config.url !== LOCAL_API_URL || config.localTunnel !== origin || config.devOrigin) throw Error('Unexpected LOCAL configuration.');
          // The browser reaches LOCAL Auth only through the same-origin proxy.
          const health = await fetch('http://localhost:5173/auth/v1/health',{headers:{apikey:config.key},signal:AbortSignal.timeout(5000)});
          if (!health.ok) throw Error('LOCAL Auth proxy is not ready.');
        } else if (config.url !== PROJECTS.dev || config.devOrigin !== origin) throw Error('Unexpected DEV configuration.');
        ready = true;
        break;
      }
    } catch {}
    await delay(1000);
  }
  if (stopping) return;
  if (!ready) throw Error(`Next.js ${local ? 'LOCAL' : 'DEV'} configuration did not become ready; tunnel was not started.`);
  await verifyServedCss('http://localhost:5173',{attempts:30});
  const binary = existsSync('work/ngrok/ngrok.exe') ? resolve('work/ngrok/ngrok.exe') : 'ngrok';
  start(binary,['http','http://localhost:5173',`--url=${origin}`,`--config=${config}`,'--inspect=false','--log=false'],{stdio:'ignore'});
  console.log(`Mobile ${local ? 'LOCAL (fictional test data only)' : 'DEV'}: ${origin}
Keep this terminal running. Ctrl+C stops Next.js and ngrok.`);
}
main().catch(error=>{console.error(error.message);stop(1);});
