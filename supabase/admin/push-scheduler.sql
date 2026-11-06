-- Operator-only hosted setup for web push (decision 2026-11-06). Never a migration and
-- never an RPC. Run once per hosted project in the Supabase SQL editor, AFTER the
-- push_notifications migration is released there and AFTER the app with
-- /api/push/dispatch and its server-only environment is deployed.
--
-- Replace the three placeholders first:
--   <DISPATCH_URL>   https://duty-scheduler-dev.vercel.app/api/push/dispatch (DEV) or
--                    https://duty-scheduler-prod.vercel.app/api/push/dispatch (PROD)
--   <PUSH_SECRET>    the same value as that Vercel environment's DUTY_PUSH_SECRET
--                    (at least 32 characters; e.g. `openssl rand -base64 48`)
--   <BYPASS_SECRET>  only if that deployment has Vercel Deployment Protection: its
--                    "Protection Bypass for Automation" secret. Otherwise skip that line.
--
-- pg_net sends the HTTP request after the scheduler's transaction commits; pg_cron
-- runs the scheduler every minute. Both are available on the Supabase free plan.

create extension if not exists pg_net;
create extension if not exists pg_cron;

-- Secrets live in Supabase Vault (encrypted at rest), readable only by privileged roles.
select vault.create_secret('<DISPATCH_URL>', 'duty_push_url', 'Duty web push sender');
select vault.create_secret('<PUSH_SECRET>', 'duty_push_secret', 'Duty web push shared secret');
-- select vault.create_secret('<BYPASS_SECRET>', 'duty_push_bypass', 'Vercel protection bypass for the push sender');

-- One job; re-running replaces it (cron.schedule upserts by name).
select cron.schedule('duty-push-tick', '* * * * *', $$select duty_private.push_tick()$$);

-- Checks (read-only):
--   select jobname, schedule, active from cron.job where jobname = 'duty-push-tick';
--   select status, return_message, start_time from cron.job_run_details
--    where jobid = (select jobid from cron.job where jobname = 'duty-push-tick') order by start_time desc limit 5;
--   select status, count(*) from public.duty_push_deliveries group by status;
--
-- Rotate a secret:  select vault.update_secret((select id from vault.secrets where name = 'duty_push_secret'), '<NEW_SECRET>');
-- Pause sending:    select cron.unschedule('duty-push-tick');   (notifications still recorded; older than 6 h expire)
