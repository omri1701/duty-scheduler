// Use the same Chromium, Ubuntu and fonts locally and in Quality CI.
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const image = 'mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27';
const external = process.env.DUTY_E2E_URL;
let server;
let browser;
let serverError;
const stop = () => {browser?.kill('SIGTERM'); server?.kill('SIGTERM');};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
try {
  if (!external) {
    server = spawn(process.execPath, ['--import', './scripts/sites-env.mjs', './node_modules/wrangler/bin/wrangler.js', 'dev', '--config', 'dist/server/wrangler.json', '--local', '--persist-to', '.wrangler/state', '--ip', '0.0.0.0', '--port', '8787', '--inspector-port', '0'], {cwd: root, stdio: 'inherit', env: {...process.env, CLOUDFLARE_CF_FETCH_ENABLED: 'false', WRANGLER_SEND_METRICS: 'false'}});
    server.on('error', error => {serverError = error;});
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (serverError) throw serverError;
      if (server.exitCode !== null) throw Error('Production preview exited before becoming ready. Run pnpm build first.');
      try {ready = (await fetch('http://127.0.0.1:8787', {signal: AbortSignal.timeout(1000)})).ok;} catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (!ready) throw Error('Production preview did not become ready.');
  }
  const linux = process.platform === 'linux';
  const url = external ?? (linux ? 'http://127.0.0.1:8787' : 'http://host.docker.internal:8787');
  browser = spawn('docker', ['run', '--rm', '--ipc=host', ...(linux ? ['--network=host'] : []), '-e', `DUTY_E2E_URL=${url}`, '-e', `CI=${process.env.CI ?? ''}`, '-v', `${root}:/work`, '-w', '/work', image, 'node', 'node_modules/@playwright/test/cli.js', 'test', '--workers=2', ...process.argv.slice(2)], {cwd: root, stdio: 'inherit'});
  process.exitCode = await new Promise((resolve, reject) => {browser.on('error', reject); browser.on('exit', code => resolve(code ?? 1));});
} catch (error) {console.error(error.message); process.exitCode = 1;}
finally {stop();}
