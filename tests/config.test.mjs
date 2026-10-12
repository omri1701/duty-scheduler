import test from 'node:test';
import assert from 'node:assert/strict';
import {GET, dynamic} from '../app/api/config/route.ts';

test('public configuration reads runtime environment and never caches responses', async () => {
 const original = {url: process.env.SUPABASE_URL, key: process.env.SUPABASE_PUBLISHABLE_KEY};
 try {
  assert.equal(dynamic, 'force-dynamic');
  for (const [url, key, status] of [
   [undefined, undefined, 503],
   ['https://example.invalid', undefined, 503],
   [undefined, 'sb_publishable_synthetic', 503],
   ['https://example.invalid', 'sb_secret_synthetic', 503],
   ['https://example.invalid', 'legacy-anon-jwt', 503],
   ['https://example.invalid', 'sb_publishable_synthetic', 200],
   ['https://changed.example.invalid', 'sb_publishable_changed', 200],
  ]) {
   if (url === undefined) delete process.env.SUPABASE_URL;
   else process.env.SUPABASE_URL = url;
   if (key === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY;
   else process.env.SUPABASE_PUBLISHABLE_KEY = key;
   const response = await GET();
   assert.equal(response.status, status);
   assert.equal(response.headers.get('cache-control'), 'no-store');
   assert.deepEqual(await response.json(), status === 200 ? {url, key} : {error: 'Not configured'});
  }
 } finally {
  if (original.url === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = original.url;
  if (original.key === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY;
  else process.env.SUPABASE_PUBLISHABLE_KEY = original.key;
 }
});

test('feature and localhost configuration use the supplied Development environment independently of Git metadata', async () => {
 const names = ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'VERCEL_GIT_COMMIT_REF', 'GITHUB_REF'];
 const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
 try {
  process.env.SUPABASE_URL = 'https://qhndiuahuxczujxxitsm.supabase.co';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_synthetic_development';
  for (const branch of [undefined, 'feature/new-application', 'develop', 'master']) {
   if (branch === undefined) {
    delete process.env.VERCEL_GIT_COMMIT_REF;
    delete process.env.GITHUB_REF;
   } else {
    process.env.VERCEL_GIT_COMMIT_REF = branch;
    process.env.GITHUB_REF = `refs/heads/${branch}`;
   }
   const response = await GET();
   assert.equal(response.status, 200);
   assert.deepEqual(await response.json(), {
    url: process.env.SUPABASE_URL, key: process.env.SUPABASE_PUBLISHABLE_KEY,
   });
  }
 } finally {
  for (const name of names) {
   if (original[name] === undefined) delete process.env[name];
   else process.env[name] = original[name];
  }
 }
});
