import test from 'node:test';
import assert from 'node:assert/strict';
import {observeSession} from '../lib/supabase/session.ts';

const user = id => ({id, email: `${id}@example.invalid`, user_metadata: {}});
const response = id => ({data: {user: id ? user(id) : null}, error: null});
const deferred = () => {let resolve; const promise = new Promise(yes => {resolve = yes;}); return {promise, resolve};};
const tick = () => new Promise(resolve => setTimeout(resolve, 10));

function fixture() {
  let callback, subscribed = false, verifiedInCallback = false, inCallback = false, unsubscribed = false;
  const queue = [], users = [], errors = [];
  let cleared = 0, ready = 0;
  const client = {auth: {
    onAuthStateChange(fn) {subscribed = true; callback = fn; return {data: {subscription: {unsubscribe() {unsubscribed = true;}}}};},
    getUser() {assert.equal(subscribed, true); verifiedInCallback ||= inCallback; return queue.shift() ?? Promise.resolve(response('admin'));},
  }};
  const callbacks = {clear() {cleared++;}, async user(u) {users.push(u.id);}, error(e) {errors.push(e);}, ready() {ready++;}};
  return {client, callbacks, queue, users, errors, emit(event, id) {inCallback = true; callback(event, id ? {user: user(id)} : null); inCallback = false;},
    get cleared() {return cleared;}, get ready() {return ready;}, get unsubscribed() {return unsubscribed;}, get verifiedInCallback() {return verifiedInCallback;}};
}

test('subscription precedes initial verification and auth work is deferred outside callbacks', async () => {
  const f = fixture(), stop = observeSession(f.client, f.callbacks);
  await tick(); f.emit('SIGNED_IN', 'admin'); await tick();
  assert.deepEqual(f.users, ['admin', 'admin']);
  assert.equal(f.verifiedInCallback, false);
  stop(); assert.equal(f.unsubscribed, true);
});

test('sign-out during initial getUser cannot resurrect the old user', async () => {
  const f = fixture(), initial = deferred(); f.queue.push(initial.promise);
  const stop = observeSession(f.client, f.callbacks);
  f.emit('SIGNED_OUT'); assert.equal(f.cleared, 1); assert.equal(f.ready, 1);
  initial.resolve(response('admin')); await tick();
  assert.deepEqual(f.users, []); assert.deepEqual(f.errors, []); stop();
});

test('initial verification failure leaves the auth subscription available for retry', async () => {
  const f = fixture(); f.queue.push(Promise.resolve({data: {user: null}, error: {name: 'NetworkError', message: 'Offline'}}));
  const stop = observeSession(f.client, f.callbacks); await tick();
  assert.equal(f.errors[0].message, 'Offline'); assert.equal(f.ready, 1);
  f.emit('SIGNED_IN', 'admin'); await tick();
  assert.deepEqual(f.users, ['admin']); stop();
});

test('account switch immediately clears the prior identity before verification', async () => {
  const f = fixture(), stop = observeSession(f.client, f.callbacks); await tick();
  const next = deferred(); f.queue.push(next.promise);
  f.emit('SIGNED_IN', 'engineer'); assert.equal(f.cleared, 1);
  await tick(); f.emit('SIGNED_OUT'); next.resolve(response('engineer')); await tick();
  assert.deepEqual(f.users, ['admin']); stop();
});

test('sign-out cancels queued auth synchronization and suppresses late errors', async () => {
  const f = fixture(), stop = observeSession(f.client, f.callbacks); await tick();
  const next = deferred(); f.queue.push(next.promise);
  f.emit('USER_UPDATED', 'admin'); await tick();
  f.emit('SIGNED_OUT'); next.resolve({data: {user: null}, error: {message: 'Old failure'}}); await tick();
  assert.deepEqual(f.errors, []);
  f.emit('SIGNED_IN', 'admin'); f.emit('SIGNED_OUT'); await tick();
  assert.deepEqual(f.users, ['admin']); stop();
});

test('unmount unsubscribes and ignores pending verification completions', async () => {
  const f = fixture(), initial = deferred(); f.queue.push(initial.promise);
  const stop = observeSession(f.client, f.callbacks); stop(); initial.resolve(response('admin')); await tick();
  assert.equal(f.unsubscribed, true); assert.deepEqual(f.users, []); assert.equal(f.ready, 0);
});

test('missing session is signed-out readiness, while token refresh preserves workspace state', async () => {
  const f = fixture(); f.queue.push(Promise.resolve({data: {user: null}, error: {name: 'AuthSessionMissingError'}}));
  const stop = observeSession(f.client, f.callbacks); await tick();
  assert.equal(f.cleared, 1); assert.equal(f.ready, 1); assert.deepEqual(f.errors, []);
  f.emit('SIGNED_IN', 'admin'); await tick();
  f.emit('TOKEN_REFRESHED', 'admin'); await tick();
  assert.deepEqual(f.users, ['admin']); assert.equal(f.cleared, 2); stop();
});

test('sign-out during workspace loading suppresses late bootstrap errors and readiness', async () => {
  const f = fixture(), load = deferred();
  f.callbacks.user = async u => {f.users.push(u.id); await load.promise; throw Error('Old load failure');};
  const stop = observeSession(f.client, f.callbacks); await tick();
  f.emit('SIGNED_OUT'); load.resolve(); await tick();
  assert.deepEqual(f.errors, []); assert.equal(f.ready, 1); stop();
});
