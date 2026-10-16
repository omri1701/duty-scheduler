import test from 'node:test';
import assert from 'node:assert/strict';
import {observeSession} from '../lib/supabase/session.ts';

const user = id => ({id, email: `${id}@example.invalid`, email_confirmed_at:'2026-10-09T10:00:00Z',is_anonymous:false,user_metadata: {}});
const response = id => ({data: {user: id ? user(id) : null}, error: null});
const session = (id = 'admin', token = id) => id ? {user: user(id), access_token: token} : null;
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
const tick = () => new Promise(resolve => setTimeout(resolve, 10));

function fixture() {
  let callback, subscribed = false, inCallback = false, unsubscribed = false, current = session();
  const queue = [], users = [], errors = [], verified = [], prepared = [];
  let cleared = 0, ready = 0;
  const client = {auth: {
    onAuthStateChange(fn) {subscribed = true; callback = fn; return {data: {subscription: {unsubscribe() {unsubscribed = true;}}}};},
    async getSession() {assert.equal(subscribed, true); assert.equal(inCallback, false); return {data: {session: current}, error: null};},
    getUser(token) {assert.equal(inCallback, false); verified.push(token); return queue.shift() ?? Promise.resolve(response(current?.user.id));},
  }};
  const callbacks = {clear() {cleared++;}, async prepare(s) {prepared.push(s.access_token); return 'uncommitted';}, async user(u, data) {users.push({id:u.id,data});}, error(e) {errors.push(e);}, ready() {ready++;}};
  return {client, callbacks, queue, users, errors, verified, prepared, setSession(s) {current=s;}, emit(event, id, token = id) {current = session(id, token); inCallback = true; callback(event, current); inCallback = false;},
    get cleared() {return cleared;}, get ready() {return ready;}, get unsubscribed() {return unsubscribed;}};
}

test('restoration and initial auth notifications share one deferred verification', async () => {
  const f = fixture(), held = deferred(); f.queue.push(held.promise);
  const stop = observeSession(f.client, f.callbacks);
  f.emit('SIGNED_IN', 'admin'); f.emit('INITIAL_SESSION', 'admin');
  await tick(); assert.deepEqual(f.verified, ['admin']); assert.deepEqual(f.prepared, ['admin']); assert.deepEqual(f.users, []);
  held.resolve(response('admin')); await stop.refresh();
  assert.deepEqual(f.users, [{id:'admin',data:'uncommitted'}]);
  f.emit('SIGNED_IN', 'admin'); await tick(); assert.equal(f.verified.length, 1);
  stop(); assert.equal(f.unsubscribed, true);
});

test('private prepared data is withheld until server verification succeeds', async () => {
  for (const fail of [false, true]) {
    const f=fixture(), held=deferred(); f.queue.push(held.promise);
    const stop=observeSession(f.client,f.callbacks); await tick();
    assert.equal(f.prepared.length,1); assert.deepEqual(f.users,[]);
    held.resolve(fail?{data:{user:null},error:{message:'Verification failed'}}:response('admin'));
    await stop.refresh(); assert.equal(f.users.length,fail?0:1); assert.equal(f.errors.length,fail?1:0); stop();
  }
});

test('sign-out during verification discards both prepared data and late verification', async () => {
  const f = fixture(), initial = deferred(); f.queue.push(initial.promise);
  const stop = observeSession(f.client, f.callbacks); await tick();
  f.emit('SIGNED_OUT', null); assert.equal(f.ready, 1);
  initial.resolve(response('admin')); await tick();
  assert.deepEqual(f.users, []); assert.deepEqual(f.errors, []); stop();
});

test('verification failure clears private state and remains retryable', async () => {
  const f = fixture(); f.queue.push(Promise.resolve({data: {user: null}, error: {name:'NetworkError',message:'Offline'}}));
  const stop = observeSession(f.client, f.callbacks); await stop.refresh();
  assert.equal(f.errors[0].message, 'Offline'); assert.equal(f.ready, 1); assert.equal(f.cleared,1);
  f.emit('SIGNED_IN', 'admin'); await stop.refresh();
  assert.equal(f.users[0].id,'admin'); stop();
});

test('account switch immediately clears old state and ignores stale successes and failures', async () => {
  for(const fail of [false,true]) {
    const f=fixture(), old=deferred(); f.queue.push(old.promise);
    const stop=observeSession(f.client,f.callbacks); await tick();
    const before=f.cleared;
    f.emit('SIGNED_IN','engineer'); assert.equal(f.cleared,before+1);
    await stop.refresh();
    if(fail)old.reject(Error('Old private failure'));else old.resolve(response('admin'));
    await tick(); assert.deepEqual(f.users.map(u=>u.id),['engineer']); assert.deepEqual(f.errors,[]);stop();
  }
});

test('a mismatched verified identity never commits prefetched private data', async () => {
  const f=fixture();f.queue.push(Promise.resolve(response('engineer')));
  const stop=observeSession(f.client,f.callbacks);await stop.refresh();
  assert.deepEqual(f.users,[]);assert.match(f.errors[0].message,/identity changed/);stop();
});

test('same-user token refresh preserves workspace; a new sign-in token revalidates', async () => {
  const f=fixture(),stop=observeSession(f.client,f.callbacks);await stop.refresh();
  f.emit('TOKEN_REFRESHED','admin','refreshed');await tick();
  assert.equal(f.users.length,1);assert.equal(f.verified.length,1);assert.equal(f.cleared,0);
  f.emit('SIGNED_IN','admin','new-login');await stop.refresh();
  assert.deepEqual(f.verified,['admin','new-login']);assert.equal(f.users.length,2);stop();
});

test('a token refresh during initial restoration still requires verification', async () => {
  const f=fixture();f.setSession(session(null));
  const stop=observeSession(f.client,f.callbacks);await stop.refresh();
  f.emit('TOKEN_REFRESHED','admin','fresh');await stop.refresh();
  assert.deepEqual(f.verified,['fresh']);assert.equal(f.users[0].id,'admin');stop();
});

test('queued auth work and late bootstrap failures are suppressed after sign-out/unmount', async () => {
  const f=fixture(),load=deferred();
  f.callbacks.user=async u=>{f.users.push(u.id);await load.promise;throw Error('Old load failure');};
  const stop=observeSession(f.client,f.callbacks);await tick();
  f.emit('SIGNED_OUT',null);load.resolve();await tick();assert.deepEqual(f.errors,[]);
  f.emit('SIGNED_IN','admin');f.emit('SIGNED_OUT',null);await tick();assert.equal(f.verified.length,1);
  stop();assert.equal(f.unsubscribed,true);
});

test('prepared-read errors are handled, never published, and can retry', async () => {
  const f=fixture(),read=deferred();f.callbacks.prepare=()=>read.promise;
  const stop=observeSession(f.client,f.callbacks);await tick();read.reject(Error('Load failed'));await stop.refresh();
  assert.deepEqual(f.users,[]);assert.equal(f.errors[0].message,'Load failed');
  f.callbacks.prepare=async()=> 'retry';await stop.refresh();assert.equal(f.users[0].data,'retry');stop();
});

test('focus, visibility and SDK events share one verification and workspace update', async t => {
  const browser=new EventTarget();
  globalThis.window=browser;globalThis.document={visibilityState:'visible'};
  t.after(()=>{delete globalThis.window;delete globalThis.document;});
  const f=fixture(),stop=observeSession(f.client,f.callbacks);await stop.refresh();
  const held=deferred();f.queue.push(held.promise);
  browser.dispatchEvent(new Event('focus'));browser.dispatchEvent(new Event('visibilitychange'));f.emit('SIGNED_IN','admin');
  await tick();assert.equal(f.verified.length,2);assert.equal(f.users.length,1);
  held.resolve(response('admin'));await stop.refresh();assert.equal(f.users.length,2);
  stop();browser.dispatchEvent(new Event('focus'));await tick();assert.equal(f.verified.length,2);
});

test('no stored session is signed-out readiness without a private read',async()=>{
  const f=fixture();f.setSession(null);const stop=observeSession(f.client,f.callbacks);await stop.refresh();
  assert.deepEqual(f.verified,[]);assert.deepEqual(f.prepared,[]);assert.equal(f.ready,1);stop();
});

test('session recovery failure reports safely and can retry',async()=>{
  const f=fixture(),original=f.client.auth.getSession;
  f.client.auth.getSession=async()=>({data:{session:null},error:{message:'Recovery failed'}});
  const stop=observeSession(f.client,f.callbacks);await stop.refresh();
  assert.deepEqual(f.verified,[]);assert.equal(f.errors[0].message,'Recovery failed');
  f.client.auth.getSession=original;await stop.refresh();assert.equal(f.users.length,1);stop();
});

test('unmount prevents queued and late verification commits',async()=>{
  const f=fixture(),stop=observeSession(f.client,f.callbacks),queued=stop.refresh();stop();await queued;
  assert.deepEqual(f.verified,[]);assert.equal(f.ready,0);
  const other=fixture(),held=deferred();other.queue.push(held.promise);
  const close=observeSession(other.client,other.callbacks),pending=close.refresh();await tick();close();held.resolve(response('admin'));await pending;
  assert.deepEqual(other.users,[]);assert.equal(other.ready,0);
});

test('token refresh while initial verification and prefetch are held shares the bootstrap',async()=>{
  for(const fail of [false,true]){
    const f=fixture(),auth=deferred(),read=deferred();f.queue.push(auth.promise);f.callbacks.prepare=s=>{f.prepared.push(s.access_token);return read.promise;};
    const stop=observeSession(f.client,f.callbacks),pending=stop.refresh();await tick();
    f.emit('TOKEN_REFRESHED','admin','rotated');await tick();
    assert.deepEqual(f.verified,['admin']);assert.deepEqual(f.prepared,['admin']);assert.deepEqual(f.users,[]);
    read.resolve('private result');
    auth.resolve(fail?{data:{user:null},error:{message:'Revoked session'}}:response('admin'));await pending;
    assert.equal(f.users.length,fail?0:1);assert.equal(f.errors.length,fail?1:0);stop();
  }
});

test('server-verified unconfirmed or anonymous users cannot publish prefetched data',async()=>{
  for(const flags of [{email_confirmed_at:null},{is_anonymous:true}]){
    const f=fixture();f.queue.push(Promise.resolve({data:{user:{...user('admin'),...flags}},error:null}));
    const stop=observeSession(f.client,f.callbacks);await stop.refresh();
    assert.deepEqual(f.users,[]);assert.equal(f.cleared,1);assert.equal(f.errors[0].message,'A verified account is required');stop();
  }
});
