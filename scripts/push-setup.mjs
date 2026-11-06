#!/usr/bin/env node
// Web push setup (decision 2026-11-06).
//   pnpm push:setup local   Sets up push on the app's isolated LOCAL stack (the one pnpm start:local
//                           and pnpm local:reset use): keys and the shared secret in .env.local
//                           (gitignored; kept when present), pg_net/pg_cron when absent, the Vault
//                           secrets and the 15-minute job. Idempotent; never touches app data. After
//                           that, every pnpm start:local / local:reset re-applies it by itself.
//                           Options: --container supabase_db_<name>, --url <dispatch URL>.
//   pnpm push:setup dev     Touches nothing. Prints paste-ready steps for the hosted Development
//   pnpm push:setup prod    or Production project with freshly generated values. Option: --bypass <secret>.
import {randomBytes} from 'node:crypto';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import webpush from 'web-push';
import {LOCAL_CONTAINER} from './local-supabase.mjs';
import {LOCAL_DISPATCH_URL, applyLocalPush, readEnvFile, setupSql} from './push-local.mjs';
import {vapidSubjectProblem} from '../lib/push/endpoint.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** push:setup local defaults to the same database container as pnpm start:local. */
export const DEFAULT_LOCAL_CONTAINER = LOCAL_CONTAINER;

const HOSTED = {
  dev: {name: 'Development', vercel: 'Preview', url: 'https://duty-scheduler-dev.vercel.app/api/push/dispatch', ref: 'qhndiuahuxczujxxitsm', protected: true},
  prod: {name: 'Production', vercel: 'Production', url: 'https://duty-scheduler-prod.vercel.app/api/push/dispatch', ref: 'hpszwgnwxtxyxpcaivgj', protected: false},
};
const CHECK = `select jobname, schedule, active from cron.job where jobname = 'duty-push-tick';
select name from vault.secrets where name like 'duty_push_%' order by name;
select status, count(*) from public.duty_push_deliveries group by status;`;
const secret = () => randomBytes(36).toString('base64url');
/** The app's public URL: a VAPID subject every push service accepts (Apple refuses placeholders). */
export const APP_URL = 'https://duty-scheduler-prod.vercel.app';
/** LOCAL subject: the phone tunnel origin (DUTY_DEV_ORIGIN) when it is a usable https URL, else the app's URL. */
export function localSubject(env) {
  const origin = env.DUTY_DEV_ORIGIN?.trim();
  return origin && origin.startsWith('https://') && !vapidSubjectProblem(origin) ? new URL(origin).origin : APP_URL;
}

function local(options) {
  // 1. Server-only keys in the gitignored local env file (existing values are kept).
  const envPath = path.join(root, '.env.local');
  const text = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const current = readEnvFile(envPath);
  const added = {};
  if (!current.VAPID_PUBLIC_KEY || !current.VAPID_PRIVATE_KEY) {
    const keys = webpush.generateVAPIDKeys();
    added.VAPID_PUBLIC_KEY = keys.publicKey; added.VAPID_PRIVATE_KEY = keys.privateKey;
  }
  // A placeholder subject (e.g. an .invalid mailto) makes Apple refuse every send: replace it.
  const subjectProblem = vapidSubjectProblem(current.VAPID_SUBJECT);
  if (subjectProblem) added.VAPID_SUBJECT = localSubject({...current, ...readEnvFile(path.join(root, '.env.dev.local'))});
  if (!current.DUTY_PUSH_SECRET || current.DUTY_PUSH_SECRET.length < 32) added.DUTY_PUSH_SECRET = secret();
  if (Object.keys(added).length) {
    const kept = text.split(/\r?\n/).filter(line => !Object.keys(added).some(key => line.startsWith(`${key}=`)));
    while (kept.length && kept.at(-1) === '') kept.pop();
    writeFileSync(envPath, [...kept, ...(kept.length ? [''] : []), '# Web push, LOCAL only (pnpm push:setup local)', ...Object.entries(added).map(([k, v]) => `${k}=${v}`), ''].join('\n'));
  }
  console.log(Object.keys(added).length ? `1. .env.local: set ${Object.keys(added).join(', ')}${added.VAPID_SUBJECT ? ` (VAPID_SUBJECT=${added.VAPID_SUBJECT}${current.VAPID_SUBJECT ? `; was refused: ${subjectProblem}` : ''})` : ''}.` : '1. .env.local: keys already present, kept.');

  // 2. Extensions when absent, Vault secrets and the job on the LOCAL database container.
  const container = options.container ?? DEFAULT_LOCAL_CONTAINER, url = options.url ?? LOCAL_DISPATCH_URL;
  const job = applyLocalPush({container, url, pushSecret: added.DUTY_PUSH_SECRET ?? current.DUTY_PUSH_SECRET});
  console.log(`2. ${container}: pg_net and pg_cron enabled, Vault secrets set, job duty-push-tick (${job}) → ${url}.`);
  console.log('3. Restart pnpm start:local so the app reads the keys (it re-applies this setup after every start and local:reset), then Settings → Enable notifications → Send a test.');
}

function hosted(mode, options) {
  const target = HOSTED[mode];
  const keys = webpush.generateVAPIDKeys(), pushSecret = secret();
  const bypass = target.protected ? (options.bypass ?? null) : undefined;
  console.log(`Web push setup for hosted ${target.name}. Nothing was changed; follow these steps in order.
Do this only after the release has applied the push migrations to ${target.name}.

1. Vercel → duty-scheduler → Settings → Environment Variables, environment "${target.vercel}" only,
   add these four (server-only; never NEXT_PUBLIC_, mark them Sensitive). VAPID_SUBJECT may instead be a real
   mailto: address, never a placeholder such as example.com or .invalid (Apple refuses every send):

VAPID_PUBLIC_KEY=${keys.publicKey}
VAPID_PRIVATE_KEY=${keys.privateKey}
VAPID_SUBJECT=${new URL(target.url).origin}
DUTY_PUSH_SECRET=${pushSecret}

2. Redeploy ${target.name} so the app reads them.
${target.protected ? `
3. Vercel → Settings → Deployment Protection → Protection Bypass for Automation: copy the secret${bypass ? ' (already filled in below)' : ' and replace <BYPASS_SECRET> below with it'}.
   Without it every send is refused (401) and nothing is delivered.
` : ''}
${target.protected ? 4 : 3}. Supabase → project ${target.ref} → SQL Editor: paste and run this once (safe to re-run):

${setupSql({url: target.url, pushSecret, bypass})}
${target.protected ? 5 : 4}. Check (read-only, same SQL Editor):

${CHECK}

   Then in the app: Settings → Enable notifications → Send a test (arrives within seconds).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [mode, ...rest] = process.argv.slice(2), options = {};
    for (let i = 0; i < rest.length; i += 2) {
      if (!/^--(container|url|bypass)$/.test(rest[i]) || rest[i + 1] === undefined) throw Error(`Unknown option ${rest[i]}`);
      options[rest[i].slice(2)] = rest[i + 1];
    }
    if (mode === 'local') local(options);
    else if (mode === 'dev' || mode === 'prod') hosted(mode, options);
    else throw Error('Usage: pnpm push:setup local|dev|prod');
  } catch (error) {console.error(error.message); process.exitCode = 1;}
}
