import test from 'node:test';
import assert from 'node:assert/strict';
import {bindAllocation, compileAllocation, deriveTransfers} from '../lib/allocation/index.ts';
import {context} from '../lib/allocation/model.ts';
import {record, replay, reconcile, sliceClaim} from '../lib/compensation/index.ts';
import {canonicalDuties, handover} from '../lib/scheduling/calendar.ts';
import {validateGeneration} from '../lib/scheduling/validate.ts';
import {monthScenario} from './fixtures/generation.mjs';

const sum = xs => xs.reduce((a, b) => a + b, 0);
const envelope = {publicationId: 'november-reviewed', sourceKey: 'publish/november-reviewed', actor: 'manager'};
const send = (events, operation, sourceKey) => record(events, {operation, sourceKey,
  actor: 'manager', reason: 'Reviewed fixture', at: (events.at(-1)?.at ?? 0) + 1}).events;
function scenario(kind = 'normal') {
  const {input: schedule, witness: assignments, now} = monthScenario(kind);
  delete schedule.targets;
  schedule.members.push({id: 'bridge', active: true, approved: true, eligible: true});
  const input = {schedule, now, seniority: schedule.members.map(m => m.id), events: send([], {
    kind: 'members', members: schedule.members.map(m => ({id: m.id, active: true})),
  }, 'members')};
  return {input, assignments};
}
/** The per-person shape: the given transfers become net changes and routing
 * pairs; the stored transfer list is their canonical derivation. */
function draftFor(input, assignments, transfers = [], repayments = []) {
  const final = Object.fromEntries(input.seniority.map(id => [id, 0]));
  for (const d of canonicalDuties(input.schedule.month, input.schedule.calendar)) final[assignments[d.id].primary] += d.units;
  const offered = {...final}, changes = Object.fromEntries(input.seniority.map(id => [id, {temporary: 0, permanent: 0}]));
  for (const t of transfers) {offered[t.fromId] += t.units; offered[t.toId] -= t.units; changes[t.fromId][t.kind] -= t.units; changes[t.toId][t.kind] += t.units;}
  const baseline = {...offered};
  for (const r of repayments) {baseline[r.claim.debtorId] -= r.units; baseline[r.claim.creditorId] += r.units;}
  // These baselines follow the actual assignments, not a fitted partition, and carry no uneven credit.
  return {sourceKey: context(input).key, baselineUnits: baseline, offeredUnits: offered,
    targetsUnits: final, repayments, changes, pairs: transfers, transfers: deriveTransfers(input.seniority, changes, transfers), uneven: []};
}
// A member with duties passes the point on: a permanent change needs a fair share to give.
function mixed(kind = 'normal') {
  const fixture = scenario(kind), {input, assignments} = fixture;
  const draft = draftFor(input, assignments, [
    {id: 'A-to-B', fromId: 'e00', toId: 'e05', kind: 'temporary', units: 2},
    {id: 'B-to-C', fromId: 'e05', toId: 'e02', kind: 'permanent', units: 2},
  ]);
  return {...fixture, draft};
}
function exclusivity(publication) {
  const used = new Map();
  for (const slice of [...publication.intents.flatMap(i => i.capacity), ...publication.reservations.map(r => r.capacity)]) {
    const ranges = used.get(slice.date) ?? [];
    assert.ok(ranges.every(s => s.offset + s.units <= slice.offset || slice.offset + slice.units <= s.offset));
    used.set(slice.date, [...ranges, slice]);
  }
}

test('separate routes cannot reuse one approved counterpart budget on different duties', () => {
 const members=['a','b'].map(id=>({id,active:true}));
 const events=send([],{kind:'members',members},'members');
 const counterpart={id:'one-transfer',fromId:'a',toId:'b',kind:'temporary',units:2};
 const intents=['2026-11-02','2026-11-04'].map((date,i)=>({id:'route-'+i,fromId:'a',toId:'b',kind:'temporary',capacity:[{date,offset:0,units:2}],
  route:[{fromId:'a',toId:'b',kind:'temporary',transferIds:['one-transfer'],counterparts:[counterpart]}]}));
 assert.throws(()=>send(events,{kind:'publication',month:'2026-11',beforeId:null,after:{id:'bad',month:'2026-11',intents,reservations:[],
  duties:['2026-11-02','2026-11-04'].map(startDate=>({startDate,endDate:startDate==='2026-11-02'?'2026-11-03':'2026-11-05',primaryId:'b',units:2}))}},'bad'),/unfunded-intent-route/);
});
const publishCommand = (input, publication, identity = envelope) => ({sourceKey: identity.sourceKey,
  actor: identity.actor, at: input.now, operation: {kind: 'publication', month: input.schedule.month, beforeId: null, after: publication}});

test('Astra: A→B temporary then B→C permanent: B carries A’s point, C takes B’s own share, charged once', async () => {
  const {input, draft, assignments} = mixed(), before = structuredClone({input, draft, assignments});
  const result = await bindAllocation(input, draft, assignments, envelope);
  assert.equal(result.bindable, true); assert.equal(result.publishable, true);
  assert.deepEqual(draft.transfers.map(t => [t.fromId, t.toId, t.kind]), [['e05', 'e02', 'permanent'], ['e00', 'e05', 'temporary']], 'permanent first');
  assert.equal(result.publication.intents.length, 2);
  const temporary = result.publication.intents.find(t => t.kind === 'temporary'), permanent = result.publication.intents.find(t => t.kind === 'permanent');
  assert.deepEqual(temporary.route.map(l => [l.fromId, l.toId, l.kind, l.transferIds]), [['e00', 'e05', 'temporary', ['temporary/e00/e05']]]);
  assert.deepEqual(permanent.route.map(l => [l.fromId, l.toId, l.kind, l.transferIds]), [['e05', 'e02', 'permanent', ['permanent/e05/e02']]]);
  assert.equal(sum(temporary.capacity.map(s => s.units)), 2); assert.equal(sum(permanent.capacity.map(s => s.units)), 2);
  const primaryOn = date => assignments[canonicalDuties(input.schedule.month, input.schedule.calendar).find(d => d.dates.includes(date)).id].primary;
  for (const s of temporary.capacity) assert.equal(primaryOn(s.date), 'e05');
  for (const s of permanent.capacity) assert.equal(primaryOn(s.date), 'e02');
  assert.equal(result.preview.net.e00, -2); assert.equal(result.preview.net.e05, 2); assert.equal(result.preview.net.e02, 0);
  assert.deepEqual(result.preview.settlements, []); exclusivity(result.publication);
  const command = publishCommand(input, result.publication);
  const committed = record(input.events, command);
  assert.deepEqual(record(committed.events, {...command, at: input.now + 1}).events, committed.events);
  const copied = record(committed.events, {sourceKey: 'publish/copied', actor: 'manager', at: input.now + 1,
    operation: {kind: 'publication', month: input.schedule.month, beforeId: result.publication.id,
      after: {...structuredClone(result.publication), id: 'copied'}}});
  assert.deepEqual(copied.net, committed.net, 'copied route identities never charge twice');
  assert.deepEqual({input, draft, assignments}, before);
});

test('a pass-through member nets out of temporary chains; a permanent-first route keeps its classification', async () => {
  for (const kinds of [['temporary', 'temporary'], ['permanent', 'temporary']]) {
    const {input, assignments} = scenario(), transfers = [
      {id: 'first', fromId: 'e00', toId: 'bridge', kind: kinds[0], units: 2},
      {id: 'second', fromId: 'bridge', toId: 'e02', kind: kinds[1], units: 2},
    ];
    const draft = draftFor(input, assignments, transfers), result = await bindAllocation(input, draft, assignments, envelope);
    assert.equal(result.bindable, true);
    const trail = result.publication.intents.flatMap(t => t.route.flatMap(l => l.counterparts));
    assert.deepEqual(trail, draft.transfers, 'routes carry the derived counterparts');
    if (kinds[0] === 'temporary') assert.deepEqual(draft.transfers.map(t => [t.fromId, t.toId]), [['e00', 'e02']], 'the zero-share bridge drops out of the nets');
    else assert.deepEqual(result.publication.intents[0].route.map(l => [l.fromId, l.toId, l.kind]), [['e00', 'bridge', 'permanent'], ['bridge', 'e02', 'temporary']]);
    assert.equal(result.preview.net.e00, kinds[0] === 'temporary' ? -2 : 0);
    assert.equal(result.preview.net.bridge, kinds[0] === 'temporary' ? 0 : -2);
    assert.equal(result.preview.net.e02, 2); exclusivity(result.publication);
  }
});

test('a deferred repayment beside a permanent transfer preserves the old source and the intermediate creditor', async () => {
  const {input, assignments} = scenario();
  input.events = send(input.events, {kind: 'claim', debtorId: 'e00', creditorId: 'e11', units: 4}, 'old');
  const claim = replay(input.events).claims[0], transfers = [
    {id: 'defer', fromId: 'e00', toId: 'e05', kind: 'temporary', units: 2},
    {id: 'permanent', fromId: 'e05', toId: 'e02', kind: 'permanent', units: 2},
  ];
  const draft = draftFor(input, assignments, transfers, [{claim, units: 4}]);
  const result = await bindAllocation(input, draft, assignments, envelope);
  assert.equal(result.bindable, true);
  const deferred = result.publication.intents.find(t => t.route.some(l => l.deferredClaim));
  assert.deepEqual(deferred.route.map(l => [l.fromId, l.toId, l.kind]), [['e11', 'e05', 'temporary']], 'the creditor’s deferred point is carried by e05');
  assert.equal(deferred.route[0].deferredClaim.path[0].lotId, 'old');
  assert.deepEqual(result.publication.intents.find(t => t !== deferred).route.map(l => [l.fromId, l.toId, l.kind]), [['e05', 'e02', 'permanent']], 'e05’s own share moves permanently');
  assert.equal(result.preview.net.e00, -4); assert.equal(result.preview.net.e05, 2); assert.equal(result.preview.net.e02, 0);
  assert.equal(sum(result.publication.reservations.map(r => r.capacity.units)), 2); exclusivity(result.publication);
});

test('actual assignments control funding; holes cannot be replaced by a feasible witness', async () => {
  const {input, draft, assignments} = mixed();
  const partial = structuredClone(assignments);
  for (const a of Object.values(partial)) if (a.primary === 'e02') a.primary = null;
  const compiled = compileAllocation(input, draft, partial);
  assert.deepEqual(compiled.check.assignments, partial); assert.equal(compiled.check.actualUnits.e02, 0);
  assert.equal(compiled.plan.unfundedUnits.e02, draft.targetsUnits.e02);
  assert.deepEqual(compiled.plan.intents.map(t => [t.fromId, t.toId, t.kind]), [['e00', 'e05', 'temporary']], 'only the work e05 really does is funded');
  const result = await bindAllocation(input, draft, partial, envelope);
  assert.equal(result.bindable, true); assert.equal(result.publishable, false);
  assert.ok(result.publication.intents.every(t => t.kind === 'temporary')); assert.equal(result.preview.net.e00, -2);
  assert.ok(result.diagnostics.some(d => d.code === 'uncovered-duty'));
  const invalid = structuredClone(assignments);
  const slot = Object.values(invalid).find(a => a.primary === 'e00'); slot.primary = 'e02';
  assert.throws(() => compileAllocation(input, draft, invalid), /target-exceeded/);
});

test('binding identities survive key order/retry and change with the actual capacity', async () => {
  const {input, draft, assignments} = mixed();
  const first = await bindAllocation(input, draft, assignments, envelope);
  const reordered = Object.fromEntries(Object.entries(assignments).reverse());
  const retry = await bindAllocation(input, draft, reordered, envelope);
  assert.deepEqual(retry.publication, first.publication);
  assert.match(first.publication.intents[0].id, /^allocation\/[a-f0-9]{64}$/);
  let changed;
  const targets = Object.fromEntries(Object.entries(draft.targetsUnits).map(([id, u]) => [id, u / 2]));
  const boundDate = first.publication.intents[0].capacity[0].date;
  for (const [date, a] of Object.entries(assignments)) {
    if (a.primary === 'e02' || date === boundDate) continue;
    const candidate = structuredClone(assignments);
    [candidate[boundDate], candidate[date]] = [candidate[date], candidate[boundDate]];
    try {validateGeneration({...input.schedule, targets}, candidate); changed = candidate; break;} catch { /* Try another valid same-weight exchange. */ }
  }
  assert.ok(changed);
  const next = await bindAllocation(input, draft, changed, envelope);
  assert.equal(next.bindable, true);
  assert.notEqual(next.publication.intents[0].id, first.publication.intents[0].id);
  assert.ok(next.publication.intents[0].capacity.every(s => changed[s.date].primary === 'e02'));
});

test('deferred repayment keeps original counterpart/source slices while reserving the normalized suffix', async () => {
  const {input, assignments} = scenario();
  input.events = send(input.events, {kind: 'claim', debtorId: 'e00', creditorId: 'e11', units: 4}, 'old');
  const claim = replay(input.events).claims[0];
  const draft = draftFor(input, assignments,
    [{id: 'defer', fromId: 'e00', toId: 'e02', kind: 'temporary', units: 2}], [{claim, units: 4}]);
  const result = await bindAllocation(input, draft, assignments, envelope);
  assert.equal(result.bindable, true);
  const leg = result.publication.intents[0].route[0];
  assert.deepEqual([leg.fromId, leg.toId], ['e11', 'e02']);
  assert.equal(leg.deferredClaim.path[0].lotId, 'old');
  assert.equal(leg.deferredClaim.path[0].offset, 2, 'original selected source retained');
  const original = result.plan.intents[0];
  assert.equal(original.normalizedDeferredClaims[0].path[0].offset, 0, 'FIFO normalization reported separately');
  assert.equal(sum(result.publication.reservations.map(r => r.capacity.units)), 2);
  assert.ok(result.publication.reservations.every(r => r.claim.path[0].offset >= 2));
  assert.equal(result.preview.net.e00, -4, 'publishing plans never settles debt');
  const completed = reconcile(result.preview.events, handover('2026-12-01') * 60000);
  assert.equal(completed.net.e00, -2); assert.equal(completed.net.e02, 2); exclusivity(result.publication);
});

test('multiple reverse transfers reserve distinct original source slices and earn only at completion', async () => {
  const {input, assignments} = scenario();
  input.events = send(input.events, {kind: 'claim', debtorId: 'e02', creditorId: 'e00', units: 4}, 'reverse');
  const transfers = [0, 1].map(i => ({id: `reverse-${i}`, fromId: 'e00', toId: 'e02', kind: 'temporary', units: 1}));
  const draft = draftFor(input, assignments, transfers);
  const result = await bindAllocation(input, draft, assignments, envelope);
  assert.equal(result.bindable, true); assert.deepEqual(result.publication.intents, []);
  assert.deepEqual(draft.transfers.map(t => t.units), [2], 'two drags merge into one derived transfer');
  assert.equal(sum(result.publication.reservations.map(r => r.units ?? r.capacity.units)), 2);
  assert.equal(Math.min(...result.publication.reservations.map(r => r.claim.path[0].offset)), 0); assert.equal(result.preview.net.e02, -4);
  const end = handover('2026-12-01') * 60000;
  assert.equal(reconcile(result.preview.events, end).net.e02, -2); exclusivity(result.publication);
});

test('weighted cross-year weekend halves bind real units and their own completion instants', async () => {
  for (const weekend of ['2027-12-31', '2028-01-01']) {
    const {input, assignments} = scenario('weighted'), debtor = assignments[weekend].primary;
    const units = sum(canonicalDuties(input.schedule.month, input.schedule.calendar)
      .filter(d => assignments[d.id].primary === debtor).map(d => d.units));
    input.events = send(input.events, {kind: 'claim', debtorId: debtor, creditorId: 'bridge', units}, 'weighted-debt');
    const claim = replay(input.events).claims[0], draft = draftFor(input, assignments, [], [{claim, units}]);
    // Every debtor unit is repayment. Only this weighted half actually performs
    // work; other missing duties must not fund the rest of the selected debt.
    const partial = structuredClone(assignments);
    for (const [date, a] of Object.entries(partial)) if (a.primary === debtor && date !== weekend) a.primary = null;
    const result = await bindAllocation(input, draft, partial, {...envelope, publicationId: 'december'});
    assert.equal(result.bindable, true); assert.equal(result.publishable, false);
    const reservations = result.publication.reservations;
    assert.equal(sum(reservations.map(r => r.capacity.units)), 5);
    assert.ok(reservations.every(r => r.capacity.date === weekend && r.capacity.offset + r.capacity.units <= 5));
    const end = handover(weekend === '2027-12-31' ? '2028-01-01' : '2028-01-02') * 60000;
    assert.equal(reconcile(result.preview.events, end - 1).net[debtor], -units);
    assert.equal(reconcile(result.preview.events, end).net[debtor], -units + 5); exclusivity(result.publication);
  }
});

test('combined weekend splits accounting atoms but never earns before the real Sunday end', async () => {
  const {input, assignments} = scenario(), date = '2026-11-06', debtor = assignments[date].primary;
  input.events = send(input.events, {kind: 'claim', debtorId: debtor, creditorId: 'bridge', units: 2}, 'weekend-debt');
  const claim = replay(input.events).claims[0], draft = draftFor(input, assignments, [], [{claim, units: 2}]);
  const partial = structuredClone(assignments);
  for (const [slot, a] of Object.entries(partial)) if (a.primary === debtor && slot !== date) a.primary = null;
  const result = await bindAllocation(input, draft, partial, envelope);
  assert.equal(result.bindable, true);
  assert.deepEqual(result.publication.reservations.map(r => r.capacity), [
    {date, offset: 0, units: 1}, {date: '2026-11-07', offset: 0, units: 1},
  ]);
  assert.equal(reconcile(result.preview.events, handover('2026-11-07') * 60000).net[debtor], -2);
  assert.equal(reconcile(result.preview.events, handover('2026-11-08') * 60000).net[debtor], 0);
});

test('future reservations exclude their source units; duplicate source and capacity cannot pass preview', async () => {
  const {input, assignments} = scenario();
  input.events = send(input.events, {kind: 'claim', debtorId: 'e02', creditorId: 'bridge', units: 4}, 'reserved-debt');
  const claim = replay(input.events).claims[0];
  input.events = send(input.events, {kind: 'publication', month: '2026-12', beforeId: null, after: {
    id: 'future', month: '2026-12', duties: [{startDate: '2026-12-01', endDate: '2026-12-02', primaryId: 'e02', units: 2}],
    intents: [], reservations: [{id: 'future-r', capacity: {date: '2026-12-01', offset: 0, units: 2}, claim: sliceClaim(claim, 2)}],
  }}, 'future');
  const available = context(input).candidates[0], selected = {claim: available, units: 2};
  const draft = draftFor(input, assignments, [], [selected]);
  const result = await bindAllocation(input, draft, assignments, envelope);
  assert.equal(result.bindable, true);
  assert.ok(result.publication.reservations.every(r => r.claim.path[0].offset >= 2));
  const duplicate = structuredClone(draft); duplicate.repayments.push(selected);
  assert.throws(() => compileAllocation(input, duplicate, assignments), /duplicate-repayment-source/);
  const forged = structuredClone(result.publication);
  forged.reservations.push({...structuredClone(forged.reservations[0]), id: 'overlap'});
  assert.throws(() => record(input.events, publishCommand(input, forged)), /overlapping-accounting-capacity|source-capacity-reserved/);
});

test('reverse work cannot silently net an obligation already reserved in a future month', async () => {
  const {input, assignments} = scenario();
  input.events = send(input.events, {kind: 'claim', debtorId: 'e02', creditorId: 'e00', units: 2}, 'reverse');
  const claim = replay(input.events).claims[0];
  input.events = send(input.events, {kind: 'publication', month: '2026-12', beforeId: null, after: {
    id: 'future', month: '2026-12', duties: [{startDate: '2026-12-01', endDate: '2026-12-02', primaryId: 'e02', units: 2}],
    intents: [], reservations: [{id: 'future-r', capacity: {date: '2026-12-01', offset: 0, units: 2}, claim}],
  }}, 'future');
  const draft = draftFor(input, assignments, [{id: 'reverse-work', fromId: 'e00', toId: 'e02', kind: 'temporary', units: 2}]);
  const before = structuredClone(input.events), result = await bindAllocation(input, draft, assignments, envelope);
  assert.equal(result.bindable, false); assert.equal(result.publication, null);
  assert.ok(result.diagnostics.some(d => d.code === 'review-unavailable-reverse-obligation'));
  assert.deepEqual(input.events, before); assert.equal(replay(input.events).net.e02, -2);
});

test('normalizing new deferral cannot silently invalidate another month’s existing reservation', async () => {
  const {input, assignments} = scenario();
  input.events = send(input.events, {kind: 'claim', debtorId: 'e00', creditorId: 'e11', units: 6}, 'old');
  const claim = replay(input.events).claims[0];
  input.events = send(input.events, {kind: 'publication', month: '2026-12', beforeId: null, after: {
    id: 'future', month: '2026-12', duties: [{startDate: '2026-12-01', endDate: '2026-12-02', primaryId: 'e00', units: 2}],
    intents: [], reservations: [{id: 'future-r', capacity: {date: '2026-12-01', offset: 0, units: 2}, claim: sliceClaim(claim, 2)}],
  }}, 'future');
  const selected = context(input).candidates[0];
  const draft = draftFor(input, assignments,
    [{id: 'defer', fromId: 'e00', toId: 'e02', kind: 'temporary', units: 2}], [{claim: selected, units: 4}]);
  const result = await bindAllocation(input, draft, assignments, envelope);
  assert.equal(result.bindable, false); assert.equal(result.publication, null);
  assert.ok(result.diagnostics.some(d => d.code === 'review-existing-reservation-normalization'));
  assert.equal(replay(input.events).contributions[0].status, 'pending');
});

test('transitive source slices must retain the same offset on every original path leg', () => {
  const {input, assignments} = scenario();
  input.events = send(input.events, {kind: 'claim', debtorId: 'e00', creditorId: 'bridge', units: 4}, 'first');
  input.events = send(input.events, {kind: 'claim', debtorId: 'bridge', creditorId: 'e11', units: 4}, 'second');
  const source = replay(input.events).claims[0], claim = {...source, ...sliceClaim(source, 2), units: 2};
  const draft = draftFor(input, assignments, [], [{claim, units: 2}]);
  draft.repayments[0].claim.path[1].offset++;
  assert.throws(() => compileAllocation(input, draft, assignments), /invalid-repayment-source/);
});

test('publication validation rejects disconnected or reclassified routes and shared funding capacity', async () => {
  const {input, draft, assignments} = mixed(), result = await bindAllocation(input, draft, assignments, envelope);
  for (const mutate of [
    p => {p.intents[0].route[0].fromId = 'e11';},
    p => {p.intents[0].route[0].kind = p.intents[0].route[0].kind === 'permanent' ? 'temporary' : 'permanent';},
    p => {p.intents[0].route[0].transferIds = [];},
  ]) {
    const invalid = structuredClone(result.publication); mutate(invalid);
    assert.throws(() => record(input.events, publishCommand(input, invalid)), /invalid-intent-route/);
  }
  const overlapping = structuredClone(result.publication);
  overlapping.intents.push({...structuredClone(overlapping.intents[0]), id: 'duplicate-capacity'});
  assert.throws(() => record(input.events, publishCommand(input, overlapping)), /overlapping-accounting-capacity/);
});

test('compound reverse routes and existing publication lineage require explicit review', async () => {
  // A zero-share pass-through member chains the route: e00's share reaches e02 through bridge,
  // whose temporary leg is work e02 already owes bridge.
  const {input, assignments} = scenario();
  input.events = send(input.events, {kind: 'claim', debtorId: 'e02', creditorId: 'bridge', units: 2}, 'reverse');
  const draft = draftFor(input, assignments, [
    {id: 'first', fromId: 'e00', toId: 'bridge', kind: 'permanent', units: 2},
    {id: 'second', fromId: 'bridge', toId: 'e02', kind: 'temporary', units: 2},
  ]);
  const ambiguous = await bindAllocation(input, draft, assignments, envelope);
  assert.equal(ambiguous.bindable, false); assert.equal(ambiguous.publication, null);
  assert.ok(ambiguous.diagnostics.some(d => d.code === 'review-compound-reverse-obligation'));
  const clean = mixed(), first = await bindAllocation(clean.input, clean.draft, clean.assignments, envelope);
  clean.input.events = first.preview.events; clean.draft.sourceKey = context(clean.input).key;
  const repeated = await bindAllocation(clean.input, clean.draft, clean.assignments, {...envelope, publicationId: 'copy'});
  assert.equal(repeated.bindable, false);
  assert.ok(repeated.diagnostics.some(d => d.code === 'review-existing-publication-lineage'));
});
