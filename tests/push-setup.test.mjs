import test from 'node:test';
import assert from 'node:assert/strict';
import {LOCAL_CONTAINER} from '../scripts/local-supabase.mjs';
import {APP_URL, DEFAULT_LOCAL_CONTAINER, localSubject} from '../scripts/push-setup.mjs';
import {vapidSubjectProblem} from '../lib/push/endpoint.ts';
import {LOCAL_DISPATCH_URL, applyLocalPush, hasPushKeys, setupSql} from '../scripts/push-local.mjs';

test('push:setup local targets the same database container as pnpm start:local and local:reset', () => {
  assert.equal(DEFAULT_LOCAL_CONTAINER, LOCAL_CONTAINER);
  assert.equal(LOCAL_CONTAINER, 'supabase_db_duty-scheduler-app');
  assert.equal(LOCAL_DISPATCH_URL, 'http://host.docker.internal:5173/api/push/dispatch');
});

test('local push setup only runs against a local Supabase database container', () => {
  for (const container of ['db.example.com', 'postgres://x', 'supabase_db_x;rm', '']) {
    assert.throws(() => applyLocalPush({container, pushSecret: 'k'.repeat(40)}), /Only a local Supabase database container/);
  }
});

test('push keys are complete only with both VAPID keys and a 32+ character secret', () => {
  assert.equal(hasPushKeys({VAPID_PUBLIC_KEY: 'p', VAPID_PRIVATE_KEY: 'q', DUTY_PUSH_SECRET: 's'.repeat(32)}), true);
  assert.equal(hasPushKeys({VAPID_PUBLIC_KEY: 'p', VAPID_PRIVATE_KEY: 'q', DUTY_PUSH_SECRET: 's'.repeat(31)}), false);
  assert.equal(hasPushKeys({VAPID_PRIVATE_KEY: 'q', DUTY_PUSH_SECRET: 's'.repeat(40)}), false);
  assert.equal(hasPushKeys({}), false);
});

test('the operator SQL is filled in, quoted, every 15 minutes, and keeps the bypass out unless asked', () => {
  const sql = setupSql({url: LOCAL_DISPATCH_URL, pushSecret: "abc'def".padEnd(40, 'x')});
  assert.match(sql, /duty_secret\('duty_push_url', 'http:\/\/host\.docker\.internal:5173\/api\/push\/dispatch'/);
  assert.match(sql, /duty_secret\('duty_push_secret', 'abc''defx+'/);
  assert.match(sql, /cron\.schedule\('duty-push-tick', '\*\/15 \* \* \* \*'/);
  assert.match(sql, /^-- select pg_temp\.duty_secret\('duty_push_bypass'/m);
  assert.doesNotMatch(sql, /'<(DISPATCH_URL|PUSH_SECRET)>'/);
  // DEV: the bypass line is active, with its placeholder (the SQL refuses to run with it) or the value.
  assert.match(setupSql({url: 'https://x.example/api/push/dispatch', pushSecret: 's'.repeat(40), bypass: null}), /^select pg_temp\.duty_secret\('duty_push_bypass', '<BYPASS_SECRET>'/m);
  assert.match(setupSql({url: 'https://x.example/api/push/dispatch', pushSecret: 's'.repeat(40), bypass: 'b$&1'}), /^select pg_temp\.duty_secret\('duty_push_bypass', 'b\$&1'/m);
});

test('push:setup local signs with a subject Apple accepts: the phone tunnel origin, else the app URL', () => {
  assert.equal(localSubject({DUTY_DEV_ORIGIN: 'https://abc-12.ngrok-free.app/'}), 'https://abc-12.ngrok-free.app');
  assert.equal(localSubject({}), APP_URL);
  assert.equal(localSubject({DUTY_DEV_ORIGIN: 'http://localhost:5173'}), APP_URL);
  assert.equal(localSubject({DUTY_DEV_ORIGIN: 'https://localhost'}), APP_URL);
  assert.equal(vapidSubjectProblem(APP_URL), null);
});
