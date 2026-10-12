import test from 'node:test';
import assert from 'node:assert/strict';

test('concurrent client initialization shares configuration and client; failed initialization can retry', async t => {
  const {getSupabase} = await import('../lib/supabase/client.ts?concurrent');
  let attempts = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(url, '/api/config');
    if (++attempts === 1) return new Response('', {status: 503});
    return Response.json({url: 'https://phase4c.supabase.invalid', key: 'sb_publishable_synthetic_only'});
  });
  await assert.rejects(getSupabase(), /not configured/);
  const [first, second] = await Promise.all([getSupabase(), getSupabase()]);
  assert.equal(first, second); assert.equal(attempts, 2);
  await first.auth.stopAutoRefresh();
});

test('malformed configuration fails with a safe message before constructing a client', async t => {
  const {getSupabase} = await import('../lib/supabase/client.ts?malformed');
  for (const config of [null, [], {}, {url: 42, key: 'sb_publishable_synthetic_only'}, {url: 'https://phase4c.supabase.invalid', key: 'invalid'}]) {
    const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(config));
    await assert.rejects(getSupabase(), /Invalid connection configuration\./);
    fetch.mock.restore();
  }
});
