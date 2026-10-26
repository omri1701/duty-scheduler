import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspace} from '../lib/supabase/workspace.ts';
import {errorMessage} from '../lib/supabase/rpc.ts';

const user = id => ({id, email: `${id}@example.invalid`, user_metadata: {full_name: id}});
const snapshot = revision => ({revision, members: ['admin','engineer','pending'].map(id=>({id,email:`${id}@example.invalid`,name:id,role:'engineer',status:id==='pending'?'pending':'approved',active:id!=='pending',seniority:0,color:'#adc9ee'})), months: [], assignments: [], constraints: [], publications: [], roles: [], memberStatuses: [], monthStatuses: [], constraintTypes: []});
const result = data => ({data, error: null});
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
const tick = () => new Promise(resolve => setImmediate(resolve));

test('captured generation writes refuse newer revisions and share the workspace save lock', async () => {
  const f = fixture(); await f.workspace.connect(f.client, user('admin'));
  let calls = 0;
  await assert.rejects(f.workspace.captured(0, async () => {calls++;}), /changed/);
  const gate = deferred();
  const first = f.workspace.captured(1, async () => {calls++; await gate.promise; return 'verified';});
  await assert.rejects(f.workspace.mutate('duty_rename_self', {p_name: 'Competing'}), /current save/);
  await assert.rejects(f.workspace.captured(1, async () => {calls++;}), /current save/);
  f.setRaw(snapshot(2)); gate.resolve();
  assert.equal(await first, 'verified'); assert.equal(calls, 1);
  assert.equal(f.snapshots.at(-1).revision, 2);
});

test('captured completion cannot restore generation data after a session change', async () => {
  const f = fixture(); await f.workspace.connect(f.client, user('admin'));
  const gate = deferred();
  const first = f.workspace.captured(1, () => gate.promise);
  const rejected = assert.rejects(first, /session changed/);
  f.workspace.clear(); gate.resolve({private: true}); await rejected;
  assert.equal(f.snapshots.at(-1), null);
});

test('authoritative context avoids a duplicate calendar load unless reconciliation advances its revision', async () => {
  const f = fixture(); await f.workspace.connect(f.client, user('admin'));
  const loads = () => f.calls.filter(c => c.name === 'duty_load').length;
  await f.workspace.captured(1, async () => ({revision: 1}), r => r.revision);
  assert.equal(loads(), 1);
  f.setRaw(snapshot(2));
  await f.workspace.captured(1, async () => ({revision: 2}), r => r.revision);
  assert.equal(loads(), 2); assert.equal(f.snapshots.at(-1).revision, 2);
});

function fixture() {
  let raw = snapshot(1);
  const calls = [], snapshots = [], errors = [], saving = [], headers = [], responses = new Map();
  const client = {rpc(name, args) {
    calls.push({name, args});
    const handler = responses.get(name);
    const request=handler ? handler(args) : Promise.resolve(result(name === 'duty_load' ? raw : null));
    request.setHeader=(name,value)=>{headers.push({name,value});return request;};
    return request;
  }};
  const workspace = createWorkspace({snapshot: s => snapshots.push(s), error: e => errors.push(e), saving: s => saving.push(s)});
  return {client, workspace, calls, snapshots, errors, saving, headers, responses, setRaw: s => {raw = s;}};
}

test('overlapping refreshes share one read, and a failed read can retry', async () => {
  for (const fail of [false, true]) {
    const f = fixture(); await f.workspace.connect(f.client, user('admin'));
    const old = deferred(); f.responses.set('duty_load', () => old.promise);
    const first = f.workspace.refresh(); await tick();
    const second = f.workspace.refresh();
    const outcome = Promise.allSettled([first, second]);
    assert.equal(f.calls.filter(c=>c.name==='duty_load').length,2);
    if (fail) old.reject({message: 'Old failure'}); else old.resolve(result(snapshot(2)));
    const outcomes=await outcome;
    assert.equal(outcomes.filter(r=>r.status==='rejected').length,fail?2:0);
    f.responses.set('duty_load', () => Promise.resolve(result(snapshot(3))));
    await f.workspace.refresh();
    assert.equal(f.snapshots.at(-1).revision, 3);
    assert.deepEqual(f.errors, []);
  }
});

test('save invalidates an earlier refresh and uses the last accepted revision', async () => {
  const f = fixture(); await f.workspace.connect(f.client, user('admin'));
  const old = deferred(); f.responses.set('duty_load', () => old.promise);
  const refresh = f.workspace.refresh(); await tick();
  f.responses.set('duty_load', () => Promise.resolve(result(snapshot(2))));
  await f.workspace.mutate('duty_rename_self', {p_name: 'Renamed', p_revision: 999});
  old.resolve(result(snapshot(1))); await refresh;
  assert.equal(f.calls.find(c => c.name === 'duty_rename_self').args.p_revision, 1);
  assert.equal(f.snapshots.at(-1).revision, 2);
});

test('manual and auth refreshes during save share the final reload', async () => {
  const f = fixture(); await f.workspace.connect(f.client, user('admin'));
  const write = deferred(); f.responses.set('duty_rename_self', () => write.promise);
  const save = f.workspace.mutate('duty_rename_self', {p_name: 'Renamed'});
  const readsBefore = f.calls.filter(c => c.name === 'duty_load').length;
  const refresh = f.workspace.refresh(), auth = f.workspace.connect(f.client, user('admin'));
  await tick();
  assert.equal(f.calls.filter(c => c.name === 'duty_load').length, readsBefore);
  f.setRaw(snapshot(2)); write.resolve(result(null));
  await Promise.all([save, refresh, auth]);
  assert.equal(f.calls.filter(c => c.name === 'duty_load').length, readsBefore + 1);
  assert.equal(f.calls.filter(c => c.name === 'duty_join').length, 0);
  assert.equal(f.snapshots.at(-1).revision, 2);
});

test('refresh started in the same turn as save cannot load an intermediate revision', async () => {
  const f = fixture(); await f.workspace.connect(f.client, user('admin'));
  const write = deferred(); f.responses.set('duty_rename_self', () => write.promise);
  const readsBefore = f.calls.filter(c => c.name === 'duty_load').length;
  const refresh = f.workspace.refresh();
  const save = f.workspace.mutate('duty_rename_self', {p_name: 'Renamed'});
  await tick();
  assert.equal(f.calls.filter(c => c.name === 'duty_load').length, readsBefore);
  write.resolve(result(null)); await Promise.all([refresh, save]);
});

test('concurrent mutations are rejected; a later save uses the refreshed revision', async () => {
  const f = fixture(); await f.workspace.connect(f.client, user('admin'));
  const write = deferred(); f.responses.set('duty_rename_self', () => write.promise);
  const first = f.workspace.mutate('duty_rename_self', {p_name: 'First'});
  await assert.rejects(f.workspace.mutate('duty_set_role', {p_member: 'admin', p_role: 'engineer'}), /current save/);
  f.setRaw(snapshot(2)); write.resolve(result(null)); await first;
  await f.workspace.mutate('duty_set_role', {p_member: 'admin', p_role: 'engineer'});
  assert.equal(f.calls.find(c => c.name === 'duty_set_role').args.p_revision, 2);
  assert.deepEqual(f.saving, [false, true, false, true, false]);
});

test('failed saves preserve the original RPC error and recover before unlocking', async () => {
  const f = fixture(); await f.workspace.connect(f.client, user('admin'));
  f.responses.set('duty_rename_self', () => Promise.resolve({error: {message: 'The team data changed.', code: '40001'}}));
  const recovery = deferred(); f.responses.set('duty_load', () => recovery.promise);
  const save = f.workspace.mutate('duty_rename_self', {p_name: 'Renamed'});
  const failed = assert.rejects(save, /The team data changed\./);
  await tick(); assert.equal(f.workspace.isSaving(), true);
  recovery.resolve(result(snapshot(3))); await failed;
  assert.equal(f.workspace.isSaving(), false);
  assert.equal(f.snapshots.at(-1).revision, 3);
  assert.equal(f.errors.at(-1), 'The team data changed.');
});

test('failed recovery cannot mask the save error or leave the save lock held', async () => {
  const f = fixture(); await f.workspace.connect(f.client, user('admin'));
  f.responses.set('duty_rename_self', () => Promise.reject({message: 'Not allowed', code: '42501'}));
  f.responses.set('duty_load', () => Promise.reject(Error('Network unavailable')));
  await assert.rejects(f.workspace.mutate('duty_rename_self', {p_name: 'Renamed'}), /Not allowed/);
  assert.equal(f.workspace.isSaving(), false);
  assert.equal(f.errors.at(-1), 'Not allowed');
  assert.equal(f.snapshots.at(-1).revision, 1);
});

test('successful write followed by failed reload reports failure and recovers', async () => {
  const f = fixture(); await f.workspace.connect(f.client, user('admin'));
  let reads = 0;
  f.responses.set('duty_load', () => ++reads === 1 ? Promise.reject(Error('Reload failed')) : Promise.resolve(result(snapshot(2))));
  await assert.rejects(f.workspace.mutate('duty_rename_self', {p_name: 'Renamed'}), /Reload failed/);
  assert.equal(f.snapshots.at(-1).revision, 2);
  assert.equal(f.workspace.isSaving(), false);
});

test('signed out or pending users cannot dispatch mutations', async () => {
  const f = fixture();
  await assert.rejects(f.workspace.mutate('duty_rename_self', {p_name: 'Renamed'}), /approved account/);
  f.setRaw(snapshot(null)); await f.workspace.connect(f.client, user('pending'));
  await assert.rejects(f.workspace.mutate('duty_rename_self', {p_name: 'Renamed'}), /approved account/);
  assert.deepEqual(f.calls.map(c => c.name), ['duty_load']);
});

test('sign-out and same-account reconnect discard old private snapshot completions', async () => {
  const f = fixture(); await f.workspace.connect(f.client, user('admin'));
  const old = deferred(); f.responses.set('duty_load', () => old.promise);
  const refresh = f.workspace.refresh(); await tick(); f.workspace.clear();
  assert.equal(f.snapshots.at(-1), null);
  f.responses.set('duty_load', () => Promise.resolve(result(snapshot(5))));
  await f.workspace.connect(f.client, user('admin'));
  old.resolve(result(snapshot(2))); await refresh;
  assert.equal(f.snapshots.at(-1).revision, 5);
});

test('old save success and failure cannot reload, report errors or unlock a new identity', async () => {
  for (const fail of [false, true]) {
    const f = fixture(); await f.workspace.connect(f.client, user('admin'));
    const old = deferred(); f.responses.set('duty_rename_self', () => old.promise);
    const oldSave = f.workspace.mutate('duty_rename_self', {p_name: 'Old'});
    const oldOutcome = oldSave.catch(e => e);
    f.workspace.clear(); await f.workspace.connect(f.client, user('engineer'));
    const current = deferred(); f.responses.set('duty_rename_self', () => current.promise);
    const newSave = f.workspace.mutate('duty_rename_self', {p_name: 'New'});
    const callsBefore = f.calls.length, errorsBefore = f.errors.length;
    if (fail) old.reject({message: 'Old private error'}); else old.resolve(result(null));
    await oldOutcome;
    assert.equal(f.workspace.isSaving(), true);
    assert.equal(f.calls.length, callsBefore);
    assert.equal(f.errors.length, errorsBefore);
    current.resolve(result(null)); await newSave;
  }
});

test('sign-out while join is pending prevents the subsequent workspace load', async () => {
  const f = fixture(), joined = deferred(); f.responses.set('duty_join', () => joined.promise);
  f.setRaw({...snapshot(null),members:[]});
  const connect = f.workspace.connect(f.client, user('admin'));
  await tick();
  f.workspace.clear(); joined.resolve(result(null)); await connect;
  assert.deepEqual(f.calls.map(c => c.name), ['duty_load','duty_join']);
  assert.equal(f.snapshots.at(-1), null);
});

test('late join transport failures cannot escape a refresh after sign-out', async () => {
  const f = fixture(), joined = deferred(); f.responses.set('duty_join', () => joined.promise);
  f.setRaw({...snapshot(null),members:[]});
  const connect = f.workspace.connect(f.client, user('admin'));
  await tick();
  const refresh = f.workspace.refresh();
  f.workspace.clear(); joined.reject(Error('Old join failure'));
  await Promise.all([connect, refresh]);
  assert.deepEqual(f.errors, []); assert.equal(f.snapshots.at(-1), null);
});

test('failed join can be retried without subscribing again', async () => {
  const f = fixture(); f.responses.set('duty_join', () => Promise.resolve({error: {message: 'Join failed'}}));
  f.setRaw({...snapshot(null),members:[]});
  await assert.rejects(f.workspace.connect(f.client, user('admin')), error => error.message === 'Join failed');
  f.responses.set('duty_join',()=>{f.setRaw(snapshot(1));return Promise.resolve(result(null));});
  await f.workspace.connect(f.client, user('admin'));
  assert.equal(f.snapshots.at(-1).revision, 1);
});

test('invalid snapshots are rejected without replacing the accepted snapshot', async () => {
  const f = fixture(); await f.workspace.connect(f.client, user('admin'));
  f.setRaw({...snapshot(2), roles: [{code: 'admin', label: 'Admin', can_manage: 'true'}]});
  await assert.rejects(f.workspace.refresh(), /Invalid team data/);
  assert.equal(f.snapshots.at(-1).revision, 1);
});

test('swap invalidation result remains available after its authoritative reload', async () => {
  const f = fixture(); await f.workspace.connect(f.client, user('engineer'));
  f.responses.set('duty_resolve_swap', () => {f.setRaw(snapshot(2)); return Promise.resolve(result('invalidated'));});
  assert.equal(await f.workspace.mutate('duty_resolve_swap', {p_request: 'swap', p_action: 'accept', p_override_reason: ''}), 'invalidated');
  assert.equal(f.snapshots.at(-1).revision, 2);
});

test('unknown thrown values use a safe fallback without serializing private data', () => {
  assert.equal(errorMessage({message: 'RPC denied', code: '42501'}, 'Fallback'), 'RPC denied');
  for (const value of [null, undefined, {private: 'Synthetic note'}, '', 42]) assert.equal(errorMessage(value, 'Fallback'), 'Fallback');
});


test('existing approved, pending, rejected and inactive members never register again', async () => {
  for(const status of ['approved','pending','rejected'])for(const active of [true,false]){
    const f=fixture(),raw=snapshot(status==='approved'&&active?1:null);
    raw.members.find(m=>m.id==='admin').status=status;raw.members.find(m=>m.id==='admin').active=active;
    f.setRaw(raw);await f.workspace.connect(f.client,user('admin'));
    assert.deepEqual(f.calls.map(c=>c.name),['duty_load']);assert.equal(f.snapshots.at(-1),raw);
  }
});

test('new user loads, registers once, then loads the new pending membership', async () => {
  const f=fixture();f.setRaw({...snapshot(null),members:[]});
  f.responses.set('duty_join',()=>{f.setRaw(snapshot(null));return Promise.resolve(result(null));});
  await f.workspace.connect(f.client,user('pending'));
  assert.deepEqual(f.calls.map(c=>c.name),['duty_load','duty_join','duty_load']);
  assert.equal(f.snapshots.at(-1).members.find(m=>m.id==='pending').status,'pending');
  assert.equal(f.calls[1].args.p_name,'pending');
});

test('failed initial read cannot trigger registration and can retry', async () => {
  const f=fixture();f.responses.set('duty_load',()=>Promise.resolve({error:{message:'Load failed'}}));
  await assert.rejects(f.workspace.connect(f.client,user('admin')),error=>error.message==='Load failed');
  assert.deepEqual(f.calls.map(c=>c.name),['duty_load']);assert.equal(f.snapshots.at(-1),null);
  f.responses.delete('duty_load');await f.workspace.connect(f.client,user('admin'));
  assert.equal(f.snapshots.at(-1).revision,1);
});

test('initial reads bind the captured token and stay unpublished until verified connect', async () => {
  const f=fixture(),s={user:user('admin'),access_token:'synthetic-captured-token'};
  const prepared=await f.workspace.prepare(f.client,s);
  assert.deepEqual(f.headers,[{name:'Authorization',value:'Bearer synthetic-captured-token'}]);
  assert.deepEqual(f.snapshots,[]);
  await assert.rejects(f.workspace.mutate('duty_rename_self',{p_name:'Unauthenticated'}),/approved account/);
  await f.workspace.connect(f.client,user('admin'),prepared);
  assert.deepEqual(f.calls.map(c=>c.name),['duty_load']);assert.equal(f.snapshots.at(-1),prepared);
});

test('refresh and another connect during registration share the bootstrap', async () => {
  const f=fixture(),joined=deferred();f.setRaw({...snapshot(null),members:[]});
  f.responses.set('duty_join',()=>joined.promise);
  const connect=f.workspace.connect(f.client,user('pending'));await tick();
  const refresh=f.workspace.refresh(),another=f.workspace.connect(f.client,user('pending'));await tick();
  assert.deepEqual(f.calls.map(c=>c.name),['duty_load','duty_join']);
  f.setRaw(snapshot(null));joined.resolve(result(null));await Promise.all([connect,refresh,another]);
  assert.deepEqual(f.calls.map(c=>c.name),['duty_load','duty_join','duty_load']);
});
