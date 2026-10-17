import test from 'node:test';
import assert from 'node:assert/strict';
import {PROJECTS} from '../lib/supabase/environment.ts';
globalThis.window={location:{origin:'http://localhost:5173'},open:()=>{}};

test('explicit Google login requests account selection while preserving PKCE and environment redirects', async t => {
  for (const [url, origin, inspection] of [
    [PROJECTS.dev, 'http://localhost:5173', false],
    [PROJECTS.dev, 'https://duty-scheduler-dev.vercel.app', false],
    [PROJECTS.prod, 'https://duty-scheduler-prod.vercel.app', false],
    [PROJECTS.prod, 'http://localhost:5173', true],
  ]) {
    window.location.origin = origin;
    const mod = await import(`../lib/supabase/client.ts?oauth=${encodeURIComponent(origin + url)}`);
    const fetch = t.mock.method(globalThis, 'fetch', async request => {
      if (request === '/api/config') return Response.json({url, key: 'sb_publishable_synthetic_only'});
      assert.equal(request, url + '/auth/v1/settings');
      return Response.json({external: {google: true}});
    });
    const client = await mod.getSupabase();
    const signIn = client.auth.signInWithOAuth.bind(client.auth);
    let authorize;
    t.mock.method(client.auth, 'signInWithOAuth', async options => {
      const result = await signIn(options);
      assert.equal(result.error, null);
      authorize = new URL(result.data.url);
      return result;
    });
    const popup = t.mock.method(window, 'open', () => {});
    try {
      await mod.signInWithGoogle();
      assert.equal(authorize.origin, url);
      assert.equal(authorize.pathname, '/auth/v1/authorize');
      assert.equal(authorize.searchParams.get('provider'), 'google');
      assert.equal(authorize.searchParams.get('prompt'), 'select_account');
      assert.equal(authorize.searchParams.get('redirect_to'), inspection ? 'https://duty-scheduler-prod.vercel.app/' : origin + '/');
      assert.ok(authorize.searchParams.get('code_challenge'));
      assert.ok(['s256', 'plain'].includes(authorize.searchParams.get('code_challenge_method')));
      assert.equal(popup.mock.callCount(), inspection ? 1 : 0);
      if (inspection) assert.deepEqual(popup.mock.calls[0].arguments, [authorize.href, '_blank', 'noopener,noreferrer']);
    } finally {
      await client.auth.stopAutoRefresh();
      fetch.mock.restore();
      popup.mock.restore();
      window.location.origin = 'http://localhost:5173';
    }
  }
});

test('concurrent client initialization shares configuration and client; failed initialization can retry', async t => {
  const {getSupabase} = await import('../lib/supabase/client.ts?concurrent');
  let attempts = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(url, '/api/config');
    if (++attempts === 1) return new Response('', {status: 503});
    return Response.json({url: 'https://qhndiuahuxczujxxitsm.supabase.co', key: 'sb_publishable_synthetic_only'});
  });
  await assert.rejects(getSupabase(), /not configured/);
  const [first, second] = await Promise.all([getSupabase(), getSupabase()]);
  assert.equal(first, second); assert.equal(attempts, 2);
  await first.auth.stopAutoRefresh();
});

test('malformed configuration fails with a safe message before constructing a client', async t => {
  const {getSupabase} = await import('../lib/supabase/client.ts?malformed');
  for (const config of [null, [], {}, {url: 42, key: 'sb_publishable_synthetic_only'}, {url: 'https://qhndiuahuxczujxxitsm.supabase.co', key: 'invalid'}]) {
    const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(config));
    await assert.rejects(getSupabase(), /Invalid connection configuration\./);
    fetch.mock.restore();
  }
});
