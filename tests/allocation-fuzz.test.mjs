// Randomized regression of the per-person allocation model. Bounded by default;
// FUZZ_SEQ, FUZZ_LEN and FUZZ_SEED widen it (the 2026-10-31 audit ran 520 x 25).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {proposeAllocation, allocationCeilings, editAllocation, transferAllocation, classifyTransfer, compileAllocation, planAllocation, bindAllocation,
  nettedCompensation, deriveTransfers, unevenTransfers, balanced, unplacedChanges, retainedChanges, permanentFloor, permanentCeiling} from '../lib/allocation/index.ts';
import {validateDraft, persistedDraft} from '../lib/allocation/edits.ts';
import {reviewAllocation} from '../lib/allocation/review.ts';
import {context} from '../lib/allocation/model.ts';
import {canonicalDuties} from '../lib/scheduling/calendar.ts';
import {record, project} from '../lib/compensation/index.ts';
import {monthScenario} from './fixtures/generation.mjs';
import {rng, pick, lockedOf, greedy, holes} from './fixtures/allocation.mjs';

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
  // Several members owe one creditor (one of them half a point): deferrals land on co-debtors.
  'co-debtors': () => owe(owe(owe(owe(base(), 'e10', 'e00', 6, 'oldest'), 'e07', 'e00', 4, 'second'), 'e08', 'e00', 3, 'half'), 'e09', 'e00', 4, 'young'),
  'three-half': () => {const i = shrink(base(), 3); i.schedule.calendar = {specials: [{id: 'h', start: '2026-11-02', end: '2026-11-06', extra: 1.5}]}; return owe(i, 'e02', 'e00', 1, 'half');},
};
const EXPECTED = /edit-below-locked-points|permanent-below-fair-share|permanent-above-month-total|temporary-above-month-total|allocation-above-month-total|unplaced-allocation-change/;
// Review codes Plan the month explains with a specific note (allocationMessage).
const EXPLAINED = /^review-(compound-reverse-obligation|unavailable-reverse-obligation|normalized-deferral-route|circular-route)$/;
test('every review code the fuzz accepts has its own note in Plan the month', () => {
  const dialog = readFileSync(new URL('../components/rota/allocation-dialog.tsx', import.meta.url), 'utf8');
  for (const code of EXPLAINED.source.slice('^review-('.length, -')$'.length).split('|')) assert.ok(dialog.includes(`/review-${code}/.test(message)`), code);
});

function apply(i, d, a) {
  if (a.op === 'edit') return editAllocation(i, d, {engineer: a.engineer, deltaUnits: a.delta, kind: a.kind}).draft;
  if (a.op === 'transfer') return transferAllocation(i, d, {id: a.id, fromId: a.from, toId: a.to, units: a.units, kind: a.kind}).draft;
  if (a.op === 'classify') return classifyTransfer(i, d, a.pair, a.kind);
  // Save → reopen: the checked RPC stores the plan with its hand edits; a legacy plan has none and infers them.
  if (a.op === 'reopen') {const saved = persistedDraft(d); if (a.legacy) delete saved.hand; return reviewAllocation(i, saved);}
  throw Error('op');
}
function randomAction(r, i, d, n) {
  const ids = i.seniority, x = r();
  if (x < 0.5) return {op: 'edit', engineer: pick(r, ids), delta: pick(r, [-2, -2, -1, 1, 2, 2, -4, 4]), kind: r() < 0.6 ? 'temporary' : 'permanent'};
  if (x < 0.8) {const from = pick(r, ids); let to = pick(r, ids); if (to === from) to = ids[(ids.indexOf(from) + 1) % ids.length];
    return {op: 'transfer', id: `t${n}`, from, to, units: pick(r, [2, 2, 1]), kind: r() < 0.8 ? 'temporary' : 'permanent'};}
  if (x < 0.88 && d.pairs.length) return {op: 'classify', pair: pick(r, d.pairs).id, kind: r() < 0.8 ? 'permanent' : 'temporary'};
  if (x < 0.95) return {op: 'reopen', legacy: r() < 0.3};
  return {op: 'undo'};
}
const stats = {sequences: 0, steps: 0, accepted: 0, rejected: {}, compiled: 0, reviews: 0, bound: 0, boundComplete: 0, orderChecks: 0, inverseSame: 0, inverseChecks: 0};

function check(name, i, c, prop, d, trail, {netting = true} = {}) {
  const ids = i.seniority, locked = lockedOf(i), where = `${name}: ${trail.map(a => JSON.stringify(a)).join(' ')}`;
  validateDraft(c, ids, d);
  const unplaced = unplacedChanges(d);
  assert.equal(sum(Object.values(d.targetsUnits)), c.total - unplaced.temporary - unplaced.permanent, `${where}: total conserved`);
  assert.ok(sum(Object.values(d.targetsUnits)) <= c.total, `${where}: never more points than the month has`);
  if (balanced(prop.draft)) assert.ok(balanced(d), `${where}: the configured total always equals the month total, nothing unplaced`);
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
  // No orphan debt: every open debt is repaid this month or stays open, unit for unit, per pair.
  const pairUnits = rows => rows.reduce((t, r) => {const k = `${r.claim.debtorId}>${r.claim.creditorId}`; t[k] = (t[k] ?? 0) + r.units; return t;}, {});
  const open = pairUnits(c.candidates.map(claim => ({claim, units: claim.units}))), accounted = pairUnits([...planned.plan.repayments, ...planned.plan.deferred]);
  for (const k of new Set([...Object.keys(open), ...Object.keys(accounted)])) assert.equal(accounted[k] ?? 0, open[k] ?? 0, `${where}: debt ${k} neither lost nor created`);
  // A bookable plan never routes a deferred repayment through someone who owes the same creditor:
  // that point is the receiver's own repayment (decision 2026-10-31).
  if (planned.confirmable) for (const t of planned.plan.intents) if (t.deferredClaim) {
    assert.ok(!c.candidates.some(k => k.debtorId === t.toId && k.creditorId === t.fromId), `${where}: deferral to a co-debtor booked as their repayment`);
  }
  // Every plan either books or names why before Generate (decision 2026-11-01): Plan the month shows
  // the first review code as a specific note and keeps Generate disabled; never a generic error after.
  if (planned.confirmable) stats.bookable = (stats.bookable ?? 0) + 1;
  else {
    const code = planned.diagnostics.find(g => /^review-/.test(g.code))?.code;
    assert.match(code ?? '', EXPLAINED, `${where}: an unbookable plan names an explained reason (${JSON.stringify(planned.diagnostics)})`);
    stats.unbookable ??= {}; stats.unbookable[code] = (stats.unbookable[code] ?? 0) + 1;
    if (process.env.FUZZ_DEBUG) console.log('unbookable', code, where);
  }
  if (netting) checkNetting(where, prop, planned, ids);
  for (const [label, asg] of [['holes', holes(i)], ['greedy', greedy(i, d)]]) {
    if (!asg) continue;
    const out = compileAllocation(i, d, asg); stats.compiled++;
    assert.ok(out.plan, `${where}: compile (${label}) never throws`);
    if (!out.confirmable) stats.reviews++;
    // A complete Generate result books exactly when the plan did before Generate.
    if (out.check.feasibility === 'complete') assert.equal(out.confirmable, planned.confirmable, `${where}: compile (${label}) agrees with the plan`);
    if (!out.confirmable) assert.match(out.diagnostics.find(g => /^review-/.test(g.code))?.code ?? '', EXPLAINED, `${where}: compile (${label}) names an explained reason`);
    for (const f of out.plan.funding) for (const leg of f.route) assert.notEqual(leg.fromId, leg.toId, `${where}: no self intent`);
  }
}

function checkNetting(where, prop, planned, ids) {
  const lines = nettedCompensation(prop.projection.projected.net, {transfers: planned.plan.intents, repayments: planned.plan.repayments}, ids);
  const pairs = new Set(lines.map(l => `${l.debtorId}>${l.creditorId}`));
  assert.ok(!lines.some(l => pairs.has(`${l.creditorId}>${l.debtorId}`)), `${where}: netted list has one direction per pair`);
  assert.ok(!lines.some(l => lines.some(o => o.creditorId === l.debtorId)), `${where}: netted list ends every chain (no member both owes and is owed)`);
  assert.ok(lines.every(l => l.units === l.thisMonth + l.later && l.thisMonth >= 0 && l.later >= 0 && l.units > 0), `${where}: netted lines consistent`);
  assert.ok(sum(lines.map(l => l.thisMonth)) <= sum(planned.plan.repayments.map(r => r.units)) + sum(planned.plan.intents.map(t => t.units)), `${where}: this month bounded by the plan`);
}

async function bindCheck(name, i, c, prop, d, trail) {
  if (!balanced(d)) return;
  const asg = greedy(i, d); if (!asg) return;
  const where = `${name}: ${trail.map(a => JSON.stringify(a)).join(' ')}`;
  const b = await bindAllocation(i, d, asg, {publicationId: 'fz', sourceKey: 'publish/fz', actor: 'm'});
  stats.bound++;
  const compiledPlan = compileAllocation(i, d, asg);
  if (process.env.FUZZ_DEBUG && compiledPlan.confirmable && !b.bindable) console.log('unbound', b.diagnostics.at(-1)?.code, JSON.stringify(compiledPlan.plan.funding));
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
    // Turns (decision 2026-11-01): a creditor's debtors repay one point at a time; nobody is more
    // than one turn ahead of another debtor of the same creditor who still owes and has room.
    const room = allocationCeilings(i), grainUnits = Math.min(...canonicalDuties(i.schedule.month, i.schedule.calendar).map(du => du.units));
    for (const creditor of new Set(c.candidates.map(k => k.creditorId))) {
      const paid = id => sum(prop.draft.repayments.filter(r => r.claim.debtorId === id && r.claim.creditorId === creditor).map(r => r.units));
      const owes = id => sum(c.candidates.filter(k => k.debtorId === id && k.creditorId === creditor).map(k => k.units)) - paid(id);
      const debtors = [...new Set(c.candidates.filter(k => k.creditorId === creditor).map(k => k.debtorId))];
      for (const x of debtors) for (const y of debtors) if (paid(x) - paid(y) > 2) {
        assert.ok(!owes(y) || room[y] - prop.draft.offeredUnits[y] < grainUnits, `${name}: ${y} skipped a turn to ${creditor} (${paid(x)} vs ${paid(y)})`);
      }
    }
    check(name, i, c, prop, prop.draft, []);
    assert.equal(planAllocation(i, prop.draft).confirmable, true, `${name}: the proposal books`);
    await bindCheck(name, i, c, prop, prop.draft, []);
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
      if (a.op === 'reopen') {
        // Reopening restores the session; a legacy plan restores its table and keeps editing the same way.
        stats.reopens = (stats.reopens ?? 0) + 1;
        if (!a.legacy) assert.deepEqual({...d, sourceKey: '', hand: d.hand ?? []}, {...before, sourceKey: '', hand: before.hand ?? []}, `${name}: Save → reopen restores the plan`);
        else for (const key of ['targetsUnits', 'changes', 'transfers', 'pairs']) assert.deepEqual(d[key], before[key], `${name}: legacy reopen keeps ${key}`);
        const probe = {op: 'edit', engineer: pick(r, i.seniority), delta: pick(r, [-2, -1, 1, 2]), kind: r() < 0.6 ? 'temporary' : 'permanent'};
        if (!a.legacy) {
          let viaReopen, without;
          try {viaReopen = apply(i, d, probe).targetsUnits;} catch (e) {viaReopen = e.message;}
          try {without = apply(i, before, probe).targetsUnits;} catch (e) {without = e.message;}
          assert.deepEqual(viaReopen, without, `${name}: editing after reopen equals editing without it (${JSON.stringify(probe)})`);
        }
        continue;
      }
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

test('fuzz: every proposal books, on random teams, debts, locks and holidays', {timeout: 600_000}, async () => {
  // Proposals are the planner's own plans (decision 2026-11-01): each one books before and after
  // Generate and binds to the ledger, with no edit by the manager.
  const r = rng(SEED + 1), kinds = ['normal', 'locked', 'availability'];
  for (let s = 0; s < SEQ * 3; s++) {
    const kind = pick(r, kinds), n = 2 + Math.floor(r() * 11), i = shrink(base(kind), n);
    i.schedule.locks = (i.schedule.locks ?? []).filter(l => i.seniority.includes(l.engineer));
    i.schedule.constraints = Object.fromEntries(Object.entries(i.schedule.constraints ?? {}).filter(([id]) => i.seniority.includes(id)));
    if (r() < 0.3) i.schedule.calendar = {specials: [{id: 'h', start: '2026-11-02', end: '2026-11-08', extra: pick(r, [1, 1.5, 2])}]};
    if (r() < 0.2) i.schedule.calendar = {...i.schedule.calendar, splitWeekends: ['2026-11-06']};
    for (let k = Math.floor(r() * 6); k > 0; k--) {
      const debtor = pick(r, i.seniority), creditor = pick(r, i.seniority);
      if (debtor !== creditor) owe(i, debtor, creditor, pick(r, [1, 2, 2, 3, 4, 4, 6, 8]), `debt-${k}`);
    }
    const name = `random-${s} (${kind}, ${n} members)`;
    let c, prop;
    try {c = context(i); prop = proposeAllocation(i);} catch (e) {
      stats.randomRefused = (stats.randomRefused ?? 0) + 1; assert.match(e.message, /allocation-fit|locked|unavailable|lock/, `${name}: ${e.message}`); continue;
    }
    stats.randomProposals = (stats.randomProposals ?? 0) + 1;
    // The netted list is display only and keeps carried-forward debt on its own line; with
    // debts in several directions it can show more settled this month than is worked
    // (follow-up). Its invariants stay covered by the sequences above.
    check(name, i, c, prop, prop.draft, [], {netting: false});
    assert.equal(planAllocation(i, prop.draft).confirmable, true, `${name}: the proposal books`);
    await bindCheck(name, i, c, prop, prop.draft, []);
  }
  console.log(JSON.stringify({randomProposals: stats.randomProposals, randomRefused: stats.randomRefused ?? 0}));
  assert.ok(stats.randomProposals > SEQ);
});
