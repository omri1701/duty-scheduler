// A sign-up linked to a temporary member (decision 2026-11-07) owns that member's row and id;
// the app must never treat the sign-in id as the member id.
import test from 'node:test';
import assert from 'node:assert/strict';
import {canManage, findMe, fromSnapshot, readSnapshot} from '../lib/supabase/snapshot.ts';
import {swapAnswerFor, visibleSwapRequests} from '../lib/supabase/swaps.ts';
import {createWorkspace} from '../lib/supabase/workspace.ts';

const member = (id, extra = {}) => ({id, email: `${id}@example.invalid`, auth_user_id: id, name: id, role: 'engineer', status: 'approved', active: true, seniority: 1, color: '#adc9ee', ...extra});
const snapshot = members => ({revision: 3, members, months: [], assignments: [], constraints: [], publications: [], roles: [{code: 'admin', label: 'Admin', can_manage: true}, {code: 'engineer', label: 'Engineer', can_manage: false}], memberStatuses: [], monthStatuses: [], constraintTypes: []});
// Dana signed in as `dana-login`; an admin linked her to the temporary member `temp-dana`.
const linked = member('temp-dana', {auth_user_id: 'dana-login', name: 'Dana'});
const team = () => snapshot([member('boss', {role: 'admin'}), member('eli'), linked, member('tal', {email: null, auth_user_id: null, is_temporary: true})]);

test('the linked sign-in resolves to the temporary member it took over', () => {
  const raw = readSnapshot(team());
  assert.equal(findMe(raw, 'dana-login')?.id, 'temp-dana');
  assert.equal(findMe(raw, 'eli')?.id, 'eli');
  // The old id of a linked or temporary member is never a sign-in.
  assert.equal(findMe(raw, 'temp-dana'), undefined);
  assert.equal(findMe(raw, 'tal'), undefined);
  // A database before the temporary-member migration has no auth_user_id: the id is the sign-in.
  const legacy = snapshot([{...member('old'), auth_user_id: undefined}]);
  assert.equal(findMe(legacy, 'old')?.id, 'old');
  assert.throws(() => readSnapshot(snapshot([{...member('x'), auth_user_id: 7}])), /Invalid team data/);
  // Signed out is nobody, also when rows carry no auth_user_id (an older database or a fixture).
  const legacyAdmin = snapshot([{...member('old'), auth_user_id: undefined, role: 'admin'}]);
  for (const none of [undefined, null, '']) {assert.equal(findMe(legacyAdmin, none), undefined); assert.equal(canManage(legacyAdmin, none), false);}
});

test('roles follow the merged row, not the sign-in id', () => {
  const raw = team(); raw.members[2].role = 'admin';
  assert.equal(canManage(raw, 'dana-login'), true);
  assert.equal(canManage(raw, 'temp-dana'), false);
  assert.equal(fromSnapshot(raw, 'dana-login').team.find(p => p.id === 'temp-dana')?.name, 'Dana');
});

test('a swap waiting on the former temporary member is now answered by that person only', () => {
  const request = {id: 'r1', month: '2099-10', source_publication_id: 'p', requester_id: 'eli', other_id: 'temp-dana', from_day: '2099-10-05', from_end_day: '2099-10-06', to_day: '2099-10-06', to_end_day: '2099-10-07', explanation: '', status: 'awaiting_engineer', accepted_by: null, accepted_at: null, created_at: '2099-09-01T00:00:00Z', resolved_at: null, resolved_by: null, result_publication_id: null, override_reason: '', proposed_by: null, requester_accepted_at: null};
  const temporary = new Set(team().members.filter(m => m.is_temporary).map(m => m.id));
  // Before the link the admin answered for her; after it, she is no longer temporary.
  assert.equal(swapAnswerFor(request, 'boss', true, new Set(['temp-dana'])), 'temp-dana');
  assert.equal(swapAnswerFor(request, 'boss', true, temporary), null);
  assert.equal(swapAnswerFor(request, 'temp-dana', false, temporary), 'temp-dana');
  assert.deepEqual(visibleSwapRequests([request], 'temp-dana', false, temporary).map(r => r.id), ['r1']);
  // The answer the admin already gave stays as it was.
  const answered = {...request, status: 'awaiting_admin', accepted_by: 'temp-dana'};
  assert.equal(swapAnswerFor(answered, 'temp-dana', false, temporary), null);
});

test('signing in as a linked member never registers a second sign-up', async () => {
  const calls = [], raw = team();
  const client = {rpc(name) {calls.push(name); const request = Promise.resolve({data: name === 'duty_load' ? raw : null, error: null}); request.setHeader = () => request; return request;}};
  const snapshots = [], workspace = createWorkspace({snapshot: s => snapshots.push(s), error: () => {}, saving: () => {}});
  await workspace.connect(client, {id: 'dana-login', email: 'dana@example.invalid', user_metadata: {full_name: 'Dana Levi'}});
  assert.deepEqual(calls, ['duty_load']);
  assert.equal(findMe(snapshots.at(-1), 'dana-login')?.id, 'temp-dana');
});
