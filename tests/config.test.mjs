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
