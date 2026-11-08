// Web push operator SQL (decision 2026-11-06), shared by `pnpm push:setup` and the isolated
// LOCAL stack (scripts/local-supabase.mjs), which re-applies it after every setup and reset.
// Docker exec into a local Supabase database container only; never a hosted connection.
import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The app's LOCAL dev server (pnpm start:local, port 5173) as seen from the database container. */
export const LOCAL_DISPATCH_URL = 'http://host.docker.internal:5173/api/push/dispatch';

const quote = value => `'${String(value).replaceAll("'", "''")}'`;

/** KEY=value lines of an env file; missing file → {}. */
export function readEnvFile(file) {
  if (!existsSync(file)) return {};
  return Object.fromEntries(readFileSync(file, 'utf8').split(/\r?\n/).map(line => line.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2].trim()]));
}

/** Whether an env has everything the sender needs (pnpm push:setup local writes these). */
export const hasPushKeys = env => Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.DUTY_PUSH_SECRET && env.DUTY_PUSH_SECRET.length >= 32);

/** supabase/admin/push-scheduler.sql filled in: the operator script, without its header.
 * bypass: undefined leaves the bypass line out; null keeps its placeholder (to paste). */
export function setupSql({url, pushSecret, bypass}) {
  let sql = readFileSync(path.join(root, 'supabase/admin/push-scheduler.sql'), 'utf8').replaceAll('\r\n', '\n');
  sql = sql.slice(sql.indexOf('create extension'));
  const fill = (placeholder, value) => {
    if (!sql.includes(`'${placeholder}'`)) throw Error(`push-scheduler.sql has no ${placeholder}`);
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

/** pg_net/pg_cron when absent, the Vault secrets and the 15-minute job, on a local container.
 * Idempotent; touches no application data. Returns the job's schedule. */
export function applyLocalPush({container, url = LOCAL_DISPATCH_URL, pushSecret}) {
  if (!/^supabase_db_[\w-]+$/.test(container)) throw Error('Only a local Supabase database container is accepted.');
  const psql = (sql, flags = []) => spawnSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', ...flags], {input: sql, encoding: 'utf8'});
  const ready = psql("select to_regprocedure('duty_private.push_tick()') is not null", ['-At']);
  if (ready.status !== 0) throw Error(`Local database ${container} is not running. Start it with pnpm start:local first.`);
  if (ready.stdout.trim() !== 't') throw Error(`Local database ${container} does not have the push migrations yet. Run pnpm local:reset (or pnpm start:local) first.`);
  const run = psql(setupSql({url, pushSecret}));
  if (run.status !== 0) throw Error(`Push setup failed on ${container}:\n${run.stderr}`);
  return psql("select schedule from cron.job where jobname='duty-push-tick'", ['-At']).stdout.trim();
}
