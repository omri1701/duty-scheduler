#!/usr/bin/env node
// Web push setup (decision 2026-11-06).
//   pnpm push:setup local   Sets up push on the LOCAL Supabase stack: keys and the shared secret in
//                           .env.local (gitignored; kept when present), pg_net/pg_cron when absent, the
//                           Vault secrets and the 15-minute job. Idempotent; never touches app data.
//                           Options: --container supabase_db_<name>, --url <dispatch URL>.
//   pnpm push:setup dev     Touches nothing. Prints paste-ready steps for the hosted Development
//   pnpm push:setup prod    or Production project with freshly generated values. Option: --bypass <secret>.
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import webpush from 'web-push';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [mode, ...rest] = process.argv.slice(2);
const options = {};
for (let i = 0; i < rest.length; i += 2) {
  if (!/^--(container|url|bypass)$/.test(rest[i]) || rest[i + 1] === undefined) fail(`Unknown option ${rest[i]}`);
  options[rest[i].slice(2)] = rest[i + 1];
}
if (!['local', 'dev', 'prod'].includes(mode)) fail('Usage: pnpm push:setup local|dev|prod');

const HOSTED = {
  dev: {name: 'Development', vercel: 'Preview', url: 'https://duty-scheduler-dev.vercel.app/api/push/dispatch', ref: 'qhndiuahuxczujxxitsm', protected: true},
  prod: {name: 'Production', vercel: 'Production', url: 'https://duty-scheduler-prod.vercel.app/api/push/dispatch', ref: 'hpszwgnwxtxyxpcaivgj', protected: false},
};
const CHECK = `select jobname, schedule, active from cron.job where jobname = 'duty-push-tick';
select name from vault.secrets where name like 'duty_push_%' order by name;
select status, count(*) from public.duty_push_deliveries group by status;`;

function fail(message) {console.error(message); process.exit(1);}
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const secret = () => randomBytes(36).toString('base64url');

/** supabase/admin/push-scheduler.sql filled in: the operator script, without its header. */
function setupSql({url, pushSecret, bypass}) {
  let sql = readFileSync(path.join(root, 'supabase/admin/push-scheduler.sql'), 'utf8').replaceAll('\r\n', '\n');
  sql = sql.slice(sql.indexOf('create extension'));
  const fill = (placeholder, value) => {
    if (!sql.includes(`'${placeholder}'`)) fail(`push-scheduler.sql has no ${placeholder}`);
    sql = sql.replace(`'${placeholder}'`, () => quote(value));
  };
  fill('<DISPATCH_URL>', url);
  fill('<PUSH_SECRET>', pushSecret);
  if (bypass !== undefined) {
    sql = sql.replace("-- select pg_temp.duty_secret('duty_push_bypass'", "select pg_temp.duty_secret('duty_push_bypass'");
    if (bypass !== null) fill('<BYPASS_SECRET>', bypass);
  }
  return sql;
}

if (mode === 'local') {
  // 1. Server-only keys in the gitignored local env file (existing values are kept).
  const envPath = path.join(root, '.env.local');
  const text = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const current = Object.fromEntries(text.split(/\r?\n/).map(line => line.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2]]));
  const added = {};
  if (!current.VAPID_PUBLIC_KEY || !current.VAPID_PRIVATE_KEY) {
    const keys = webpush.generateVAPIDKeys();
    added.VAPID_PUBLIC_KEY = keys.publicKey; added.VAPID_PRIVATE_KEY = keys.privateKey;
  }
  if (!current.VAPID_SUBJECT) added.VAPID_SUBJECT = 'mailto:duty-local@example.invalid';
  if (!current.DUTY_PUSH_SECRET || current.DUTY_PUSH_SECRET.length < 32) added.DUTY_PUSH_SECRET = secret();
  if (Object.keys(added).length) {
    const kept = text.split(/\r?\n/).filter(line => !Object.keys(added).some(key => line.startsWith(`${key}=`)));
    while (kept.length && kept.at(-1) === '') kept.pop();
    writeFileSync(envPath, [...kept, ...(kept.length ? [''] : []), '# Web push, LOCAL only (pnpm push:setup local)', ...Object.entries(added).map(([k, v]) => `${k}=${v}`), ''].join('\n'));
  }
  const pushSecret = added.DUTY_PUSH_SECRET ?? current.DUTY_PUSH_SECRET;
  console.log(Object.keys(added).length ? `1. .env.local: added ${Object.keys(added).join(', ')}.` : '1. .env.local: keys already present, kept.');

  // 2. The local database container only (no hosted connection exists here).
  const projectId = readFileSync(path.join(root, 'supabase/config.toml'), 'utf8').match(/^project_id\s*=\s*"([\w-]+)"/m)?.[1];
  const container = options.container ?? `supabase_db_${projectId}`;
  if (!/^supabase_db_[\w-]+$/.test(container)) fail('Only a local Supabase database container is accepted.');
  const psql = (sql, flags = []) => spawnSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', ...flags], {input: sql, encoding: 'utf8'});
  const ready = psql("select to_regprocedure('duty_private.push_tick()') is not null", ['-At']);
  if (ready.status !== 0) fail(`Local database ${container} is not running. Start the local stack first.\n${ready.stderr}`);
  if (ready.stdout.trim() !== 't') fail(`Local database ${container} does not have the push migrations yet. Apply the migrations first.`);

  // 3. Extensions when absent, Vault secrets and the job: idempotent, no application data.
  const url = options.url ?? 'http://host.docker.internal:5173/api/push/dispatch';
  const run = psql(setupSql({url, pushSecret}));
  if (run.status !== 0) fail(`Setup failed on ${container}:\n${run.stderr}`);
  const job = psql("select schedule from cron.job where jobname='duty-push-tick'", ['-At']).stdout.trim();
  console.log(`2. ${container}: pg_net and pg_cron enabled, Vault secrets set, job duty-push-tick (${job}) → ${url}.`);
  console.log('3. Restart `pnpm dev` so the app reads the keys, then Settings → Enable notifications → Send a test.');
} else {
  const target = HOSTED[mode];
  const keys = webpush.generateVAPIDKeys(), pushSecret = secret();
  const bypass = target.protected ? (options.bypass ?? null) : undefined;
  console.log(`Web push setup for hosted ${target.name}. Nothing was changed; follow these steps in order.
Do this only after the release has applied the push migrations to ${target.name}.

1. Vercel → duty-scheduler → Settings → Environment Variables, environment "${target.vercel}" only,
   add these four (server-only; never NEXT_PUBLIC_, mark them Sensitive):

VAPID_PUBLIC_KEY=${keys.publicKey}
VAPID_PRIVATE_KEY=${keys.privateKey}
VAPID_SUBJECT=mailto:you@example.com   (replace with a real contact address)
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
