// Randomized regression of the per-person allocation model. Bounded by default;
// FUZZ_SEQ, FUZZ_LEN and FUZZ_SEED widen it (the 2026-10-31 audit ran 520 x 25).
import test from 'node:test';
import assert from 'node:assert/strict';
import {proposeAllocation, editAllocation, transferAllocation, classifyTransfer, compileAllocation, planAllocation, bindAllocation,
  nettedCompensation, deriveTransfers, unevenTransfers, balanced, unplacedChanges, retainedChanges, permanentFloor, permanentCeiling} from '../lib/allocation/index.ts';
import {validateDraft} from '../lib/allocation/edits.ts';
import {context} from '../lib/allocation/model.ts';
import {canonicalDuties} from '../lib/scheduling/calendar.ts';
import {validateGeneration} from '../lib/scheduling/validate.ts';
import {record, project} from '../lib/compensation/index.ts';
import {monthScenario} from './fixtures/generation.mjs';

const SEQ = Number(process.env.FUZZ_SEQ ?? 20), LEN = Number(process.env.FUZZ_LEN ?? 14), SEED = Number(process.env.FUZZ_SEED ?? 20261031);
const sum = xs => xs.reduce((a, b) => a + b, 0);
const send = (h, operation, sourceKey, at = (h.at(-1)?.at ?? 0) + 1) => record(h, {operation, sourceKey, at, actor: 'manager', reason: 'fuzz'}).events;
function base(kind = 'normal') {
  const {input, now} = monthScenario(kind), schedule = structuredClone(input); delete schedule.targets;
  return {schedule, now, seniority: schedule.members.map(m => m.id),
    events: send([], {kind: 'members', members: schedule.members.map(m => ({id: m.id, active: true}))}, 'members')};
}
const owe = (i, d, c, u, id) => {i.events = send(i.events, {kind: 'claim', debtorId: d, creditorId: c, units: u}, id); return i;};
function shrink(i, n) {
  i.schedule.members = i.schedule.members.slice(0, n); i.seniority = i.seniority.slice(0, n);
  i.events = send([], {kind: 'members', members: i.schedule.members.map(m => ({id: m.id, active: true}))}, 'members');
  return i;
}
const holiday = (extra = 2) => {const i = base(); i.schedule.calendar = {specials: [{id: 'h', start: '2026-11-01', end: '2026-11-15', extra}]}; return i;};
const SCENARIOS = {
  normal: () => base(),
  holiday: () => holiday(),
  locked: () => base('locked'),
  availability: () => base('availability'),
  'split-weekend': () => {const i = base(); i.schedule.calendar = {splitWeekends: ['2026-11-06', '2026-11-13']}; return i;},
  debts: () => owe(owe(owe(base(), 'e00', 'e11', 8, 'old'), 'e01', 'e10', 3, 'half'), 'e05', 'e03', 2, 'young'),
  'holiday-debts': () => owe(owe(holiday(), 'e00', 'e11', 6, 'old'), 'e07', 'e02', 1, 'half'),
  'small-uneven': () => {const i = shrink(base(), 5); i.schedule.calendar = {specials: [{id: 'h', start: '2026-11-02', end: '2026-11-06', extra: 1.5}]}; return owe(i, 'e04', 'e00', 3, 'old');},
  'locked-debts': () => owe(base('locked'), 'e02', 'e08', 4, 'old'),
  // Small teams like a local two-member workspace: one member can absorb only what the other has.
  two: () => shrink(base(), 2),
  'two-debt': () => owe(shrink(base(), 2), 'e00', 'e01', 4, 'old'),
  'three-half': () => {const i = shrink(base(), 3); i.schedule.calendar = {specials: [{id: 'h', start: '2026-11-02', end: '2026-11-06', extra: 1.5}]}; return owe(i, 'e02', 'e00', 1, 'half');},
};
function rng(seed) {let s = seed >>> 0; return () => {s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296;};}
const pick = (r, xs) => xs[Math.floor(r() * xs.length)];
const EXPECTED = /edit-below-locked-points|permanent-below-fair-share|permanent-above-month-total|temporary-above-month-total|allocation-above-month-total/;

function lockedOf(i) {
  const duties = canonicalDuties(i.schedule.month, i.schedule.calendar), locked = Object.fromEntries(i.seniority.map(id => [id, 0]));
  for (const l of i.schedule.locks ?? []) locked[l.engineer] += duties.find(d => d.id === l.dutyId).units;
  return locked;
}
/** Greedy valid primary assignment toward targets (may be partial); no solver. */
function greedy(i, d) {
  let best = null;
  for (let k = 0; k < 8; k++) {
    const a = greedyOnce(i, d, k); if (!a) continue;
    const missing = Object.values(a).filter(x => x.primary === null).length;
    if (!best || missing < best.missing) best = {a, missing};
    if (!missing) break;
  }
  return best?.a ?? null;
}
function greedyOnce(i, d, k) {
  const jitter = rng(k * 7919 + 1), duties = canonicalDuties(i.schedule.month, i.schedule.calendar), out = {}, got = {}, last = {}, weekends = {};
  for (const id of i.seniority) {got[id] = 0; weekends[id] = new Set();}
  const lock = Object.fromEntries((i.schedule.locks ?? []).map(l => [l.dutyId, l.engineer]));
  for (const du of duties) if (lock[du.id]) got[lock[du.id]] += du.units;
  for (const du of duties) {
    let chosen = lock[du.id] ?? null;
    if (!chosen) {
      const ok = i.seniority.filter(id => got[id] + du.units <= d.targetsUnits[id] &&
        !du.dates.some(x => i.schedule.constraints?.[id]?.[x] === 'no') && !(last[id] !== undefined && last[id] >= du.start) &&
        !(du.weekendId && weekends[id].size && !weekends[id].has(du.weekendId)) &&
        !(i.schedule.neighbors ?? []).some(n => n.engineer === id) &&
        !duties.some(o => lock[o.id] === id && (o.start === du.end || o.end === du.start || (o.start < du.end && du.start < o.end))));
      const weight = Object.fromEntries(ok.map(id => [id, (d.targetsUnits[id] - got[id]) + (k ? jitter() * 3 : 0)]));
      ok.sort((a, b) => weight[b] - weight[a]); chosen = ok[0] ?? null;
      if (chosen) got[chosen] += du.units;
    }
    out[du.id] = {primary: chosen, ...(i.schedule.secondary?.[du.id] ? {secondary: i.schedule.secondary[du.id]} : {})};
    if (chosen) {last[chosen] = du.end; if (du.weekendId) weekends[chosen].add(du.weekendId);}
  }
  try {validateGeneration({...i.schedule, targets: Object.fromEntries(i.seniority.map(id => [id, d.targetsUnits[id] / 2]))}, out); return out;}
  catch {return null;}
}
const holes = i => {const lock = Object.fromEntries((i.schedule.locks ?? []).map(l => [l.dutyId, l.engineer]));
  return Object.fromEntries(canonicalDuties(i.schedule.month, i.schedule.calendar).map(du => [du.id, {primary: lock[du.id] ?? null}]));};

function apply(i, d, a) {
  if (a.op === 'edit') return editAllocation(i, d, {engineer: a.engineer, deltaUnits: a.delta, kind: a.kind}).draft;
  if (a.op === 'transfer') return transferAllocation(i, d, {id: a.id, fromId: a.from, toId: a.to, units: a.units, kind: a.kind}).draft;
  if (a.op === 'classify') return classifyTransfer(i, d, a.pair, a.kind);
  throw Error('op');
}
function randomAction(r, i, d, n) {
  const ids = i.seniority, x = r();
  if (x < 0.5) return {op: 'edit', engineer: pick(r, ids), delta: pick(r, [-2, -2, -1, 1, 2, 2, -4, 4]), kind: r() < 0.6 ? 'temporary' : 'permanent'};
  if (x < 0.8) {const from = pick(r, ids); let to = pick(r, ids); if (to === from) to = ids[(ids.indexOf(from) + 1) % ids.length];
    return {op: 'transfer', id: `t${n}`, from, to, units: pick(r, [2, 2, 1]), kind: r() < 0.8 ? 'temporary' : 'permanent'};}
  if (x < 0.92 && d.pairs.length) return {op: 'classify', pair: pick(r, d.pairs).id, kind: r() < 0.8 ? 'permanent' : 'temporary'};
  return {op: 'undo'};
}
const stats = {sequences: 0, steps: 0, accepted: 0, rejected: {}, compiled: 0, reviews: 0, bound: 0, boundComplete: 0, orderChecks: 0, inverseSame: 0, inverseChecks: 0};

function check(name, i, c, prop, d, trail) {
  const ids = i.seniority, locked = lockedOf(i), where = `${name}: ${trail.map(a => JSON.stringify(a)).join(' ')}`;
  validateDraft(c, ids, d);
  const unplaced = unplacedChanges(d);
  assert.equal(sum(Object.values(d.targetsUnits)), c.total - unplaced.temporary - unplaced.permanent, `${where}: total conserved`);
  assert.ok(sum(Object.values(d.targetsUnits)) <= c.total, `${where}: never more points than the month has`);
  for (const id of ids) {
    assert.ok(d.targetsUnits[id] >= locked[id] && d.targetsUnits[id] >= 0, `${where}: ${id} above lock`);
    assert.ok(d.changes[id].permanent >= permanentFloor(d, id), `${where}: ${id} permanent floor`);
    assert.ok(d.changes[id].permanent <= permanentCeiling(c.total, d, id), `${where}: ${id} fair + Permanent within the month`);
    assert.ok(Math.abs(d.changes[id].temporary) <= c.total && d.targetsUnits[id] <= c.total, `${where}: ${id} Temporary and points within the month`);
    assert.equal(d.offeredUnits[id] + d.changes[id].temporary + d.changes[id].permanent, d.targetsUnits[id], `${where}: ${id} points`);
  }
  assert.deepEqual(d.transfers, deriveTransfers(ids, d.changes, d.pairs), `${where}: canonical transfers`);
  // Uneven credit follows the real permanent load: never above the baseline's excess, never for a member at or below the split.
  const weights = canonicalDuties(i.schedule.month, i.schedule.calendar).map(du => du.units);
  assert.deepEqual(d.uneven, unevenTransfers(ids, weights, d.baselineUnits, d.changes), `${where}: canonical uneven credit`);
  const plainCredit = unevenTransfers(ids, weights, d.baselineUnits);
  for (const id of ids) {
    const now = sum(d.uneven.filter(u => u.toId === id).map(u => u.units)), before = sum(plainCredit.filter(u => u.toId === id).map(u => u.units));
    assert.ok(now <= Math.max(0, before - Math.max(0, -d.changes[id].permanent)), `${where}: ${id} credited only for extra still carried`);
    const owes = sum(d.uneven.filter(u => u.fromId === id).map(u => u.units)), owed = sum(plainCredit.filter(u => u.fromId === id).map(u => u.units));
    assert.ok(owes <= Math.max(0, owed - Math.max(0, d.changes[id].permanent)), `${where}: ${id} owes only while below the split`);
  }
  for (const t of d.transfers) assert.ok(!d.transfers.some(o => o.kind === t.kind && o.fromId === t.toId && o.toId === t.fromId), `${where}: no mutual transfers`);
  // The per-person state alone determines the table: rebuilding it reproduces the draft.
  const again = proposeAllocation(i, retainedChanges(d)).draft;
  for (const key of ['targetsUnits', 'changes', 'pairs', 'transfers']) assert.deepEqual(again[key], d[key], `${where}: state determines ${key}`);
  if (!balanced(d)) {
    assert.equal(compileAllocation(i, d, holes(i)).confirmable, false, `${where}: unbalanced never confirmable`);
    return;
  }
  const planned = planAllocation(i, d);
  assert.ok(planned.plan, `${where}: a balanced draft always plans`);
  const lines = nettedCompensation(prop.projection.projected.net, {transfers: planned.plan.intents, repayments: planned.plan.repayments}, ids);
  const pairs = new Set(lines.map(l => `${l.debtorId}>${l.creditorId}`));
  assert.ok(!lines.some(l => pairs.has(`${l.creditorId}>${l.debtorId}`)), `${where}: netted list has one direction per pair`);
  assert.ok(!lines.some(l => lines.some(o => o.creditorId === l.debtorId)), `${where}: netted list ends every chain (no member both owes and is owed)`);
  assert.ok(lines.every(l => l.units === l.thisMonth + l.later && l.thisMonth >= 0 && l.later >= 0 && l.units > 0), `${where}: netted lines consistent`);
  assert.ok(sum(lines.map(l => l.thisMonth)) <= sum(planned.plan.repayments.map(r => r.units)) + sum(planned.plan.intents.map(t => t.units)), `${where}: this month bounded by the plan`);
  for (const [label, asg] of [['holes', holes(i)], ['greedy', greedy(i, d)]]) {
    if (!asg) continue;
    const out = compileAllocation(i, d, asg); stats.compiled++;
    assert.ok(out.plan, `${where}: compile (${label}) never throws`);
    if (!out.confirmable) stats.reviews++;
    for (const f of out.plan.funding) for (const leg of f.route) assert.notEqual(leg.fromId, leg.toId, `${where}: no self intent`);
  }
}

async function bindCheck(name, i, c, prop, d, trail) {
  if (!balanced(d)) return;
  const asg = greedy(i, d); if (!asg) return;
  const where = `${name}: ${trail.map(a => JSON.stringify(a)).join(' ')}`;
  const b = await bindAllocation(i, d, asg, {publicationId: 'fz', sourceKey: 'publish/fz', actor: 'm'});
  stats.bound++;
  const compiledPlan = compileAllocation(i, d, asg);
  if (compiledPlan.confirmable) assert.ok(b.bindable, `${where}: a confirmable plan binds (${b.diagnostics.at(-1)?.code})`);
  if (!b.bindable || !b.publishable) return;
  stats.boundComplete++;
  // After all work completes: actual net = opening + compiled temporary intents - compiled repayments.
  const far = Date.parse(i.schedule.month + '-01T00:00:00Z') + 70 * 86400000;
  const actual = project(b.preview.events, far, far).actual, view = actual.net, ids = i.seniority;
  // Halves and points alike net across people: a published ledger never leaves a member in the middle of a chain.
  assert.ok(!actual.claims.some(c => actual.claims.some(o => c.creditorId === o.debtorId)), `${where}: published claims end every chain`);
  const later = Object.fromEntries(ids.map(id => [id, project(i.events, far, far).actual.net[id] ?? 0]));
  for (const t of compiledPlan.plan.intents) if (t.kind === 'temporary') {later[t.toId] += t.units; later[t.fromId] -= t.units;}
  for (const r of compiledPlan.plan.repayments) {later[r.claim.debtorId] += r.units; later[r.claim.creditorId] -= r.units;}
  for (const id of ids) assert.equal(view[id] ?? 0, later[id], `${where}: published net of ${id} matches the compiled plan`);
}

test('fuzz: per-person allocation sequences keep floors, conservation, canonical transfers and ledger parity', {timeout: 1_800_000}, async () => {
  const r = rng(SEED), names = Object.keys(SCENARIOS);
  for (let s = 0; s < SEQ; s++) {
    const name = names[s % names.length], i = SCENARIOS[name](), c = context(i), prop = proposeAllocation(i);
    stats.sequences++;
    check(name, i, c, prop, prop.draft, []);
    let d = prop.draft; const history = [d], trail = [];
    for (let k = 0; k < LEN; k++) {
      const a = randomAction(r, i, d, `${s}-${k}`); stats.steps++;
      if (a.op === 'undo') {if (history.length > 1) {const at = Math.floor(r() * history.length); d = history[at]; history.length = at + 1; trail.push({op: 'undo', to: at});} continue;}
      let next;
      try {next = apply(i, d, a);} catch (e) {
        stats.rejected[e.message] = (stats.rejected[e.message] ?? 0) + 1;
        assert.match(e.message, EXPECTED, `${name}: unexpected rejection of ${JSON.stringify(a)} after ${trail.map(x => JSON.stringify(x)).join(' ')}`);
        continue;
      }
      stats.accepted++; trail.push(a); history.push(next);
      const before = d; d = next;
      check(name, i, c, prop, d, trail);
      // The opposite click restores that member's net change of the kind; its points too unless the
      // member held an automatic point of the other kind, which moved on when the member became hand edited.
      if (a.op === 'edit') {
        stats.inverseChecks++;
        let back;
        // The opposite click can hit a bound the first did not (a + no one can absorb, after the
        // first click's automatic point of the other kind moved on); that is a refusal, not a change.
        try {back = apply(i, d, {...a, delta: -a.delta});} catch (e) {
          assert.match(e.message, EXPECTED, `${name}: unexpected rejection of the inverse of ${JSON.stringify(a)}`);
          stats.inverseRefused = (stats.inverseRefused ?? 0) + 1;
          if (process.env.FUZZ_DEBUG) console.log('inverse refused', name, e.message, JSON.stringify(before.changes), JSON.stringify(before.hand), JSON.stringify(a), JSON.stringify(d.changes));
          continue;
        }
        const other = a.kind === 'temporary' ? 'permanent' : 'temporary';
        assert.equal(back.changes[a.engineer][a.kind], before.changes[a.engineer][a.kind], `${name}: inverse restores the member`);
        if (before.hand?.includes(a.engineer) || !before.changes[a.engineer][other]) assert.equal(back.targetsUnits[a.engineer], before.targetsUnits[a.engineer], `${name}: inverse restores the points`);
        if (JSON.stringify(back.targetsUnits) === JSON.stringify(before.targetsUnits)) stats.inverseSame++;
      }
      if (k % 7 === 6) await bindCheck(name, i, c, prop, d, trail);
    }
    await bindCheck(name, i, c, prop, d, trail);
    // Order independence: the same per-person intents in another order give the same table.
    const hand = d.hand ?? [];
    if (hand.length >= 2 && !d.pairs.length) {
      stats.orderChecks++;
      let y = prop.draft;
      for (const id of [...hand].sort(() => r() - .5)) for (const kind of ['temporary', 'permanent']) {
        const delta = d.changes[id][kind] - y.changes[id][kind];
        if (delta) y = editAllocation(i, y, {engineer: id, deltaUnits: delta, kind}).draft;
        else if (!y.hand?.includes(id)) y = editAllocation(i, editAllocation(i, y, {engineer: id, deltaUnits: 2, kind}).draft, {engineer: id, deltaUnits: -2, kind}).draft;
      }
      assert.deepEqual(y.targetsUnits, d.targetsUnits, `${name}: order independent`); assert.deepEqual(y.transfers, d.transfers);
    }
  }
  console.log(JSON.stringify(stats));
  assert.ok(stats.sequences > 0 && stats.compiled > 0 && stats.bound > 0);
});
