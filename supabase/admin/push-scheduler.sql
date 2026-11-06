-- Operator-only setup for web push (decision 2026-11-06). Never a migration and never an
-- RPC. `pnpm push:setup dev|prod` prints this script filled in for that hosted project
-- (run it in its Supabase SQL editor); `pnpm push:setup local` runs it on the local stack.
-- Run it AFTER the push migrations are applied there and AFTER the app with
-- /api/push/dispatch and its server-only environment is deployed. Safe to re-run: it
-- updates the secrets and the job in place and never touches application data.
--
-- Placeholders:
--   <DISPATCH_URL>   that deployment's /api/push/dispatch URL
--   <PUSH_SECRET>    the same value as that deployment's DUTY_PUSH_SECRET (32+ characters)
--   <BYPASS_SECRET>  only where Vercel Deployment Protection is on (DEV): its
--                    "Protection Bypass for Automation" secret. Otherwise leave that line out.
--
-- Cost: pg_cron runs duty_private.push_tick() every 15 minutes (96 runs a day). An idle run
-- is a handful of indexed queries, reads no secret and makes no HTTP request. Event alerts
-- do not wait for it: they are handed to pg_net when their change commits. pg_net sends
-- after the commit; both extensions are on the Supabase free plan.

create extension if not exists pg_net;
create extension if not exists pg_cron;
-- The queued requests carry the shared secret in their headers: no client role reads pg_net's tables.
revoke all on all tables in schema net from anon, authenticated;
revoke usage on schema net from anon, authenticated;

-- Secrets live in Supabase Vault (encrypted at rest), readable only by privileged roles.
create or replace function pg_temp.duty_secret(p_name text, p_value text, p_description text) returns void language plpgsql as $f$
begin
 if p_value ~ '^<[A-Z_]+>$' then raise exception 'Replace % with its value first', p_value; end if;
 if exists(select 1 from vault.secrets where name=p_name) then
  perform vault.update_secret((select id from vault.secrets where name=p_name), p_value);
 else
  perform vault.create_secret(p_value, p_name, p_description);
 end if;
end $f$;
select pg_temp.duty_secret('duty_push_url', '<DISPATCH_URL>', 'Duty web push sender');
select pg_temp.duty_secret('duty_push_secret', '<PUSH_SECRET>', 'Duty web push shared secret');
-- select pg_temp.duty_secret('duty_push_bypass', '<BYPASS_SECRET>', 'Vercel protection bypass for the push sender');

-- One job, every 15 minutes; re-running replaces it (cron.schedule upserts by name). The
-- job itself keeps only 7 days of its pg_cron run history and 90 days of notifications.
select cron.schedule('duty-push-tick', '*/15 * * * *', $$select duty_private.push_tick()$$);

-- Check (read-only):
--   select jobname, schedule, active from cron.job where jobname = 'duty-push-tick';
--   select status, return_message, start_time from cron.job_run_details
--    where jobid = (select jobid from cron.job where jobname = 'duty-push-tick') order by start_time desc limit 5;
--   select status, count(*) from public.duty_push_deliveries group by status;
--
-- Pause sending:    select cron.unschedule('duty-push-tick');   (alerts still go out at commit
--                   while the Vault secrets exist; delete them to stop everything)
