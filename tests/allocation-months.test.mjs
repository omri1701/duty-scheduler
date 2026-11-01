// Multi-month scenario fuzzer of Plan the month (decision 2026-11-01): random teams, debts,
// locks, holidays and hand edits run for several consecutive months, each month proposed,
// edited, generated, bound and published into the ledger the next month starts from.
// Bounded by default; MONTHS_SEQ, MONTHS_LEN and MONTHS_SEED widen it (the 2026-11-01 audit ran 60 x 5).
import test from 'node:test';
import assert from 'node:assert/strict';
import loadHighs from 'highs';
import {createHighsAdapter, createGenerationRequest, solveGeneration} from '../lib/scheduling/index.ts';
import {proposeAllocation, allocationDivisible, allocationCeilings, editAllocation, transferAllocation, classifyTransfer, compileAllocation, planAllocation,
  bindAllocation, balanced, persistedDraft, unplacedChanges} from '../lib/allocation/index.ts';
import {reviewAllocation} from '../lib/allocation/review.ts';
import {context} from '../lib/allocation/model.ts';
import {partitionable} from '../lib/allocation/fit.ts';
import {canonicalDuties} from '../lib/scheduling/calendar.ts';
import {record, project} from '../lib/compensation/index.ts';
import {rng, pick, lockedOf, greedy} from './fixtures/allocation.mjs';

const SEQ = Number(process.env.MONTHS_SEQ ?? 3), LEN = Number(process.env.MONTHS_LEN ?? 4), SEED = Number(process.env.MONTHS_SEED ?? 20261101);
const sum = xs => xs.reduce((a, b) => a + b, 0);
const solver = await createHighsAdapter(loadHighs);
// Edits the manager can be refused, with the reason the plan shows; anything else is a bug.
const REFUSED = /edit-below-locked-points|permanent-below-fair-share|permanent-above-month-total|temporary-above-month-total|allocation-above-month-total|unplaced-allocation-change/;
// Plans the ledger can't book, each named by its own note before Generate.
const EXPLAINED = /^review-(compound-reverse-obligation|unavailable-reverse-obligation|normalized-deferral-route|circular-route)$/;
const nextMonth = m => {const [y, n] = m.split('-').map(Number); return n === 12 ? `${y + 1}-01` : `${y}-${String(n + 1).padStart(2, '0')}`;};
const far = month => Date.parse(`${month}-01T00:00:00Z`) + 400 * 86400000;

/** One team's ledger and membership, carried from month to month. */
function team(r) {
  const size = 3 + Math.floor(r() * 10), ids = Array.from({length: size}, (_, k) => `m${String(k).padStart(2, '0')}`);
  const start = Date.parse('2026-11-01T00:00:00Z') - 30 * 86400000;
  let events = record([], {operation: {kind: 'members', members: ids.map(id => ({id, active: true}))}, sourceKey: 'members', at: start, actor: 'manager'}).events;
  const t = {ids, active: new Set(ids), events, joined: size, at: start};
  for (let k = Math.floor(r() * 5); k > 0; k--) claim(t, r);
  return t;
}
function send(t, operation, sourceKey) {t.at += 1000; t.events = record(t.events, {operation, sourceKey, at: t.at, actor: 'manager', reason: 'Fuzz'}).events;}
function claim(t, r) {
  const active = [...t.active], debtorId = pick(r, active), creditorId = pick(r, active);
  if (debtorId !== creditorId) send(t, {kind: 'claim', debtorId, creditorId, units: pick(r, [1, 2, 2, 2, 4, 4, 6, 8])}, `claim-${t.events.length}`);
}
function input(t, r, month) {
  const now = Date.parse(`${month}-01T00:00:00Z`) - 7 * 86400000;
  if (t.at >= now) throw Error('fixture clock');
  const seniority = t.ids.filter(id => t.active.has(id)), duties = canonicalDuties(month, {});
  const calendar = {};
  if (r() < 0.25) calendar.specials = [{id: 'h', start: `${month}-0${2 + Math.floor(r() * 5)}`, end: `${month}-1${Math.floor(r() * 5)}`, extra: pick(r, [1, 1.5, 2])}];
  if (r() < 0.15) calendar.splitWeekends = [duties.find(d => d.weekendId).startDate];
  const locks = [];
  if (r() < 0.3) for (const d of canonicalDuties(month, calendar).filter(d => !d.weekendId && Number(d.startDate.slice(8)) % 5 === 2).slice(0, 2)) {
    const engineer = pick(r, seniority); if (!locks.some(l => l.engineer === engineer)) locks.push({dutyId: d.id, engineer});
  }
  return {schedule: {month, calendar, members: seniority.map(id => ({id, active: true, approved: true, eligible: true})), constraints: {},
    locks, approvals: [], sourceRevision: `fuzz-${month}`}, seniority, events: t.events, now};
}
/** A valid complete assignment: greedy first, the solver when greedy leaves a hole. */
function assign(i, d, seed) {
  const g = greedy(i, d);
  if (g && Object.values(g).every(a => a.primary)) return g;
  const result = solveGeneration(solver, createGenerationRequest({...i.schedule, targets: Object.fromEntries(i.seniority.map(id => [id, d.targetsUnits[id] / 2]))},
    {now: i.now, seed, seconds: 10}));
  return result.complete ? result.assignments : null;
}
function edit(r, i, d, n) {
  const ids = i.seniority, x = r();
  if (x < 0.45) return editAllocation(i, d, {engineer: pick(r, ids), deltaUnits: pick(r, [-2, -2, -1, 1, 2, 2, -4, 4]), kind: r() < 0.6 ? 'temporary' : 'permanent'}).draft;
  if (x < 0.85) {
    const fromId = pick(r, ids); let toId = pick(r, ids); if (toId === fromId) toId = ids[(ids.indexOf(fromId) + 1) % ids.length];
    return transferAllocation(i, d, {id: `p${n}`, fromId, toId, units: pick(r, [2, 2, 1]), kind: r() < 0.8 ? 'temporary' : 'permanent'}).draft;
  }
  if (d.pairs.length) return classifyTransfer(i, d, pick(r, d.pairs).id, r() < 0.8 ? 'permanent' : 'temporary');
  return d;
}
/** Turns (decision 2026-11-01): each point of a creditor's relief went to a debtor with the
 * fewest turns (published repayment of the open debt plus this month's), so after the month no
 * debtor who received a point is more than that point ahead of a debtor who still owes and has room. */
function turns(name, i, c, draft) {
  const duties = canonicalDuties(i.schedule.month, i.schedule.calendar), room = allocationCeilings(i), grain = Math.min(...duties.map(du => du.units));
  const lockOf = new Map((i.schedule.locks ?? []).map(l => [l.dutyId, l.engineer])), locked = lockedOf(i);
  const free = duties.filter(du => !lockOf.has(du.id)).map(du => du.units), lockedWeights = i.seniority.map(id => duties.filter(du => lockOf.get(du.id) === id).map(du => du.units));
  for (const creditor of new Set(c.candidates.map(k => k.creditorId))) {
    const debtors = [...new Set(c.candidates.filter(k => k.creditorId === creditor).map(k => k.debtorId))];
    const progress = id => {
      const open = new Set(c.candidates.filter(k => k.debtorId === id && k.creditorId === creditor).flatMap(k => k.path.map(p => p.lotId)));
      return sum(c.projection.actual.contributions.filter(k => k.status !== 'cancelled' && k.claim.debtorId === id && k.claim.creditorId === creditor &&
        k.claim.path.some(p => open.has(p.lotId))).map(k => k.capacity.units));
    };
    const paid = id => sum(draft.repayments.filter(x => x.claim.debtorId === id && x.claim.creditorId === creditor).map(x => x.units));
    const owes = id => sum(c.candidates.filter(k => k.debtorId === id && k.creditorId === creditor).map(k => k.units)) - paid(id);
    for (const x of debtors) for (const y of debtors) {
      if (x === y || !paid(x) || owes(y) < grain || room[y] - draft.offeredUnits[y] < grain) continue;
      if (progress(x) + paid(x) - 2 <= progress(y) + paid(y)) continue;
      // A turn passes on only when giving it to y instead (x's last step back) could not split the month exactly.
      const back = Math.min(2, paid(x)), instead = [2, 1].filter(a => a <= owes(y) && a % grain === 0 && a <= room[y] - draft.offeredUnits[y]);
      const exactly = a => {const o = {...draft.offeredUnits}; o[x] -= back; o[y] += a; o[creditor] += back - a;
        return o[creditor] >= locked[creditor] && partitionable(free, lockedWeights, i.seniority.map(id => o[id]));};
      assert.ok(!instead.some(exactly), `${name}: ${x} took a turn to ${creditor} ahead of ${y} (${progress(x)}+${paid(x)} vs ${progress(y)}+${paid(y)})`);
    }
  }
}

const stats = {months: 0, published: 0, edits: 0, refused: {}, unbookable: {}, partialEdits: 0, proposalsFailed: {}};
test('months: proposals book, edits book or are named, Generate agrees, and the ledger carries every debt', {timeout: 3_600_000}, async () => {
  // Each team has its own stream, so MONTHS_ONLY replays one team alone.
  for (let s = 0; s < SEQ; s++) {
    if (process.env.MONTHS_ONLY && Number(process.env.MONTHS_ONLY) !== s) continue;
    const r = rng(SEED + s * 7919), t = team(r);
    let month = '2026-11';
    for (let m = 0; m < LEN; m++, month = nextMonth(month)) {
      // Between months: someone joins (newest), someone leaves, or a manual debt is recorded.
      if (m && r() < 0.25) {const id = `m${String(t.joined++).padStart(2, '0')}`; t.ids.push(id); t.active.add(id); send(t, {kind: 'members', members: [{id, active: true}]}, `join-${id}`);}
      if (m && r() < 0.15 && t.active.size > 3) {const id = pick(r, [...t.active]); t.active.delete(id); send(t, {kind: 'members', members: [{id, active: false}]}, `leave-${id}-${m}`);}
      if (m && r() < 0.3) claim(t, r);
      const i = input(t, r, month), name = `team ${s} ${month} (${i.seniority.length} members)`;
      stats.months++;
      let c, prop;
      try {c = context(i); prop = proposeAllocation(i);} catch (e) {stats.proposalsFailed[e.message] = (stats.proposalsFailed[e.message] ?? 0) + 1; throw Error(`${name}: proposal failed: ${e.message}`);}
      const d0 = prop.draft, locked = lockedOf(i);
      // The proposal: balanced, the month total, within locks and floors, booked, in turns.
      assert.ok(balanced(d0), `${name}: proposal balanced`);
      assert.equal(sum(Object.values(d0.targetsUnits)), c.total, `${name}: proposal places the month total`);
      for (const id of i.seniority) assert.ok(d0.targetsUnits[id] >= locked[id], `${name}: ${id} at least its locks`);
      assert.ok(allocationDivisible(i, d0.targetsUnits), `${name}: the month's duties make the proposal's exact points`);
      const p0 = planAllocation(i, d0);
      assert.equal(p0.confirmable, true, `${name}: the proposal books (${JSON.stringify(p0.diagnostics)})`);
      turns(name, i, c, d0);
      // Hand edits: each is either refused with its reason or keeps the month total; reopening keeps them.
      let d = d0;
      for (let k = Math.floor(r() * 6); k > 0; k--) {
        let next; stats.edits++;
        try {next = edit(r, i, d, `${s}-${m}-${k}`);} catch (e) {
          assert.match(e.message, REFUSED, `${name}: unexpected refusal`); stats.refused[e.message] = (stats.refused[e.message] ?? 0) + 1; continue;
        }
        const unplaced = unplacedChanges(next);
        assert.equal(sum(Object.values(next.targetsUnits)), c.total - unplaced.temporary - unplaced.permanent, `${name}: edit keeps the total`);
        const reopened = reviewAllocation(i, persistedDraft(next));
        for (const key of ['targetsUnits', 'changes', 'pairs', 'transfers', 'repayments']) assert.deepEqual(reopened[key], next[key], `${name}: reopen keeps ${key}`);
        assert.deepEqual([...(reopened.hand ?? [])].sort(), [...(next.hand ?? [])].sort(), `${name}: reopen keeps the hand edits`);
        d = next;
      }
      if (!balanced(d)) d = d0;
      let planned = planAllocation(i, d);
      if (!planned.confirmable) {
        // Named before Generate; the manager undoes the edits.
        const code = planned.diagnostics.find(g => /^review-/.test(g.code))?.code;
        assert.match(code ?? '', EXPLAINED, `${name}: an unbookable plan names its reason (${JSON.stringify(planned.diagnostics)})`);
        stats.unbookable[code] = (stats.unbookable[code] ?? 0) + 1;
        d = d0; planned = p0;
      }
      // Generate, then the same booking after it; Publish binds it into the ledger.
      // A half point in a whole-point month is partial at Generate by design (the plan is never
      // blocked); the manager then undoes the edits. The proposal itself always generates in full.
      let assignments = assign(i, d, s * 100 + m);
      if (!assignments && d !== d0) {stats.partialEdits++; d = d0; planned = p0; assignments = assign(i, d, s * 100 + m);}
      assert.ok(assignments, `${name}: the proposal generates in full`);
      const compiled = compileAllocation(i, d, assignments);
      assert.equal(compiled.check.feasibility, 'complete', `${name}: complete`);
      assert.equal(compiled.confirmable, true, `${name}: Generate agrees with the plan (${JSON.stringify(compiled.diagnostics)})`);
      const bound = await bindAllocation(i, d, assignments, {publicationId: `pub-${month}`, sourceKey: `publish/${month}`, actor: 'manager'});
      assert.equal(bound.bindable && bound.publishable, true, `${name}: Publish binds (${bound.diagnostics.at(-1)?.code})`);
      // Every debt is carried: once the month is worked, each net is the opening net plus the
      // month's new temporary work minus its repayments; no claim is negative, none chains.
      const before = project(i.events, far(month), far(month)).actual, after = project(bound.preview.events, far(month), far(month)).actual;
      const expected = Object.fromEntries(t.ids.map(id => [id, before.net[id] ?? 0]));
      for (const x of compiled.plan.intents) if (x.kind === 'temporary') {expected[x.toId] += x.units; expected[x.fromId] -= x.units;}
      for (const x of compiled.plan.repayments) {expected[x.claim.debtorId] += x.units; expected[x.claim.creditorId] -= x.units;}
      for (const id of t.ids) assert.equal(after.net[id] ?? 0, expected[id], `${name}: ${id}'s debts carried`);
      assert.equal(sum(Object.values(after.net)), 0, `${name}: debts balance`);
      assert.ok(after.claims.every(k => k.units > 0), `${name}: no empty or negative debt`);
      // Debts with a member who left are frozen and never net; every live debt ends its chain.
      const live = after.claims.filter(k => !k.frozen);
      assert.ok(!live.some(k => live.some(o => k.creditorId === o.debtorId)), `${name}: no member both owes and is owed`);
      t.events = bound.preview.events; t.at = i.now; stats.published++;
    }
  }
  console.log(JSON.stringify(stats));
  if (process.env.MONTHS_ONLY) return;
  assert.equal(stats.published, stats.months, 'every month publishes');
});
