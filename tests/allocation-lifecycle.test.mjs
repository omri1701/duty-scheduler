// Lifecycle fuzzer of Plan the month (decision 2026-11-01): the user's real flow is not
// only forward. Two months are planned before either starts; at random the manager plans
// or reopens one, pushes it to extremes (all points on one member, + until refused,
// Permanent to the cap), undoes, walks back to a fair plan, saves and reopens, publishes,
// re-plans and republishes, deletes the only version, plans the later month from the
// earlier one's debts and then goes back to the earlier one, and reviews a stale tab.
// Bounded by default; LIFE_SEQ, LIFE_LEN and LIFE_SEED widen it (the 2026-11-01 audit ran 40 x 14).
import test from 'node:test';
import assert from 'node:assert/strict';
import loadHighs from 'highs';
import {createHighsAdapter, createGenerationRequest, solveGeneration} from '../lib/scheduling/index.ts';
import {proposeAllocation, editAllocation, transferAllocation, compileAllocation, planAllocation, bindAllocation, balanced,
  persistedDraft, unplacedChanges, allocationDivisible} from '../lib/allocation/index.ts';
import {reopenAllocation, reviewAllocation} from '../lib/allocation/review.ts';
import {context} from '../lib/allocation/model.ts';
import {record, project, replanEvents} from '../lib/compensation/index.ts';
import {rng, pick, greedy} from './fixtures/allocation.mjs';

const SEQ = Number(process.env.LIFE_SEQ ?? 3), LEN = Number(process.env.LIFE_LEN ?? 10), SEED = Number(process.env.LIFE_SEED ?? 20261102);
const sum = xs => xs.reduce((a, b) => a + b, 0);
const solver = await createHighsAdapter(loadHighs);
const MONTHS = ['2026-12', '2027-01'], FAR = Date.parse('2028-01-01T00:00:00Z');
// Refusals the plan names; anything else is a bug.
const REFUSED = /edit-below-locked-points|permanent-below-fair-share|permanent-above-month-total|temporary-above-month-total|allocation-above-month-total|unplaced-allocation-change/;
const BLOCKED = /^review-replan-(later:\d{4}-\d{2}|started|settled)$/;
const EXPLAINED = /^review-(compound-reverse-obligation|unavailable-reverse-obligation|normalized-deferral-route|circular-route|existing-reservation-normalization)$/;

function team(r) {
  const ids = Array.from({length: 4 + Math.floor(r() * 6)}, (_, k) => `m${k}`);
  const t = {ids, at: Date.parse('2026-11-05T00:00:00Z'), manual: Object.fromEntries(ids.map(id => [id, 0])),
    versions: Object.fromEntries(MONTHS.map(m => [m, []])), counted: {}, stats: {}};
  t.events = record([], {operation: {kind: 'members', members: ids.map(id => ({id, active: true}))}, sourceKey: 'members', at: t.at, actor: 'manager'}).events;
  for (let k = Math.floor(r() * 4); k > 0; k--) {
    const debtorId = pick(r, ids), creditorId = pick(r, ids), units = pick(r, [2, 2, 4, 6]);
    if (debtorId === creditorId) continue;
    t.at += 1000; t.events = record(t.events, {operation: {kind: 'claim', debtorId, creditorId, units}, sourceKey: `claim-${k}`, at: t.at, actor: 'manager', reason: 'Fuzz'}).events;
    t.manual[debtorId] -= units; t.manual[creditorId] += units;
  }
  return t;
}
const count = (t, key) => {t.stats[key] = (t.stats[key] ?? 0) + 1;};
/** The ledger Plan the month plans a month from: without the month's own entries once it has any. */
function planInput(t, month) {
  t.at += 1000;
  const schedule = {month, calendar: {}, constraints: {}, locks: [], approvals: [], sourceRevision: `life-${month}-${t.at}`,
    members: t.ids.map(id => ({id, active: true, approved: true, eligible: true}))};
  const booked = t.events.some(e => e.operation.kind === 'publication' && e.operation.month === month);
  return {schedule, seniority: t.ids, now: t.at, events: booked ? replanEvents(t.events, month, t.at) : t.events};
}
/** Each month counts the plan whose ledger entries are live: temporary work, plus repayments still reserved. */
function checkLedger(t, where) {
  const expected = {...t.manual};
  for (const month of MONTHS) for (const [id, units] of Object.entries(t.counted[month] ?? {})) expected[id] += units;
  const actual = project(t.events, FAR, FAR).actual;
  assert.deepEqual(Object.fromEntries(t.ids.map(id => [id, actual.net[id] ?? 0])), expected, `${where}: the ledger is the sum of the counted plans`);
  const live = actual.claims.filter(k => !k.frozen);
  assert.ok(!live.some(k => live.some(o => k.creditorId === o.debtorId)), `${where}: no live chain`);
}
const effect = (plan, repayments = true) => {
  const e = {};
  const add = (id, n) => {e[id] = (e[id] ?? 0) + n;};
  for (const x of plan.intents) if (x.kind === 'temporary') {add(x.toId, x.units); add(x.fromId, -x.units);}
  if (repayments) for (const x of plan.repayments) {add(x.claim.debtorId, x.units); add(x.claim.creditorId, -x.units);}
  return e;
};
function assign(i, d, seed) {
  const g = greedy(i, d);
  if (g && Object.values(g).every(a => a.primary)) return g;
  const result = solveGeneration(solver, createGenerationRequest({...i.schedule, targets: Object.fromEntries(i.seniority.map(id => [id, d.targetsUnits[id] / 2]))},
    {now: i.now, seed, seconds: 10}));
  return result.complete ? result.assignments : null;
}
/** The user can always get back to a fair plan: some member's change steps toward zero until none is left. */
function backToFair(i, d, where) {
  for (let round = 0; round < 400; round++) {
    const moving = i.seniority.flatMap(id => ['temporary', 'permanent'].filter(kind => d.changes[id][kind]).map(kind => ({id, kind})));
    if (!moving.length) return d;
    let next;
    for (const {id, kind} of moving) {
      const step = -Math.sign(d.changes[id][kind]) * Math.min(2, Math.abs(d.changes[id][kind]));
      try {next = editAllocation(i, d, {engineer: id, deltaUnits: step, kind}).draft; break;} catch (e) {assert.match(e.message, REFUSED, where);}
    }
    // No one free can take a +/−: a drag from the member furthest above fair to the one
    // furthest below, of the same kind, moves both (the dialog says "Drag a point instead").
    for (const kind of next ? [] : ['temporary', 'permanent']) {
      const order = [...i.seniority].sort((a, b) => d.changes[b][kind] - d.changes[a][kind]), [from, to] = [order[0], order.at(-1)];
      if (d.changes[from][kind] <= 0 || d.changes[to][kind] >= 0) continue;
      const units = Math.min(2, d.changes[from][kind], -d.changes[to][kind]);
      try {next = transferAllocation(i, d, {id: `fair-${round}-${kind}`, fromId: from, toId: to, units, kind}).draft; break;} catch (e) {assert.match(e.message, REFUSED, where);}
    }
    assert.ok(next, `${where}: no control can move the plan back toward fair (${JSON.stringify(d.changes)})`);
    d = next;
  }
  assert.fail(`${where}: the plan did not get back to fair`);
}
function extreme(r, i, d, n) {
  const x = pick(r, i.seniority), kind = r() < 0.7 ? 'temporary' : 'permanent', mode = r();
  if (mode < 0.4) {
    // Everyone drags all their points onto one member.
    for (const id of i.seniority) if (id !== x && d.targetsUnits[id]) {
      try {d = transferAllocation(i, d, {id: `all-${n}-${id}`, fromId: id, toId: x, units: d.targetsUnits[id], kind}).draft;} catch (e) {assert.match(e.message, REFUSED);}
    }
    return d;
  }
  // + (or −) on one member until refused.
  const sign = mode < 0.8 ? 1 : -1;
  for (let k = 0; k < 60; k++) {
    try {d = editAllocation(i, d, {engineer: x, deltaUnits: 2 * sign, kind}).draft;} catch (e) {assert.match(e.message, REFUSED); break;}
  }
  return d;
}

test('lifecycle: plan, extremes, undo, back to fair, publish, re-plan, delete and later months keep the ledger the sum of the plans', {timeout: 3_600_000}, async () => {
  const totals = {};
  for (let s = 0; s < SEQ; s++) {
    if (process.env.LIFE_ONLY && Number(process.env.LIFE_ONLY) !== s) continue;
    const r = rng(SEED + s * 104729), t = team(r);
    const saved = {};
    for (let k = 0; k < LEN; k++) {
      const month = pick(r, MONTHS), where = `team ${s} step ${k} ${month}`, action = r();
      let i;
      try {i = planInput(t, month);} catch (e) {
        // Going back to a month a later month already repays from: named, and fixed by
        // deleting the later month's only version first.
        assert.match(e.message, BLOCKED, where); count(t, e.message.replace(/:.*/, ''));
        const later = /later:(\d{4}-\d{2})/.exec(e.message)?.[1];
        if (later && t.versions[later].length === 1 && r() < 0.7) deleteOnly(t, later, `${where} (unblock)`);
        continue;
      }
      const c = context(i), published = t.versions[month].at(-1);
      // Draft: a reopened published copy reviews as published; a saved draft reopens unchanged.
      let d = published && r() < 0.6 ? reopenAllocation(i, persistedDraft(published.draft)) : saved[month] && r() < 0.5 ? reopenAllocation(i, persistedDraft(saved[month])) : proposeAllocation(i).draft;
      if (published) {
        // A reopened published month is lowered one point at a time down to fair and raised
        // again (December 2026: Local Admin 27 → 2): every step is accepted and books or names why.
        let walk = reopenAllocation(i, persistedDraft(published.draft));
        assert.equal(sum(Object.values(walk.targetsUnits)), c.total, `${where}: the reopened copy places the month`);
        const top = [...i.seniority].sort((a, b) => walk.changes[b].temporary - walk.changes[a].temporary)[0];
        const stepped = [];
        for (let n = 0; n < 40 && walk.changes[top].temporary > 0; n++) {
          try {stepped.push(walk = editAllocation(i, walk, {engineer: top, deltaUnits: -Math.min(2, walk.changes[top].temporary), kind: 'temporary'}).draft);}
          catch (e) {assert.match(e.message, REFUSED, where); stepped.push(walk = backToFair(i, walk, where)); break;}
        }
        for (let n = 0; n < 3; n++) {try {stepped.push(walk = editAllocation(i, walk, {engineer: top, deltaUnits: 2, kind: 'temporary'}).draft);} catch (e) {assert.match(e.message, REFUSED, where);}}
        for (const x of stepped) {
          const p = planAllocation(i, x);
          if (!p.confirmable) assert.match(p.diagnostics.find(g => /^review-/.test(g.code))?.code ?? '', EXPLAINED, `${where}: a step down names why it can't book`);
        }
        count(t, 'walked');
      }
      const history = [d];
      for (let e = Math.floor(r() * 3); e >= 0; e--) {d = extreme(r, i, d, `${s}-${k}-${e}`); history.push(d);}
      if (r() < 0.3 && history.length > 1) d = history[Math.floor(r() * history.length)]; // undo
      assert.equal(sum(Object.values(d.targetsUnits)) + unplacedChanges(d).temporary + unplacedChanges(d).permanent, c.total, `${where}: total`);
      const reopened = reviewAllocation(i, persistedDraft(d));
      for (const key of ['targetsUnits', 'changes', 'pairs']) assert.deepEqual(reopened[key], d[key], `${where}: Save → reopen keeps ${key}`);
      assert.deepEqual(reviewAllocation(i, persistedDraft(reopened)).targetsUnits, reopened.targetsUnits, `${where}: reopening again changes nothing`);
      // A stale tab's draft (from before the last ledger change) reviews or names why.
      if (saved[month]) try {reviewAllocation(i, persistedDraft(saved[month]));} catch (error) {assert.match(error.message, /repayment|source|stale|invalid-ordinary-baseline/, `${where}: stale tab`);}
      // The user can always get back to a fair plan from here.
      const fair = backToFair(i, d, where);
      assert.equal(planAllocation(i, fair).confirmable, true, `${where}: the fair plan books`);
      saved[month] = d;
      if (action < 0.25) continue; // saved only
      // Publish: the extreme plan when it books and generates in full, else the fair one.
      const planned = balanced(d) && planAllocation(i, d);
      if (planned && !planned.confirmable) assert.match(planned.diagnostics.find(g => /^review-/.test(g.code))?.code ?? '', EXPLAINED, where);
      let final = planned?.confirmable && allocationDivisible(i, d.targetsUnits) ? d : fair, assignments = assign(i, final, s * 1000 + k);
      if (!assignments && final !== fair) {final = fair; assignments = assign(i, final, s * 1000 + k);}
      assert.ok(assignments, `${where}: the fair plan generates in full`);
      const compiled = compileAllocation(i, final, assignments);
      assert.equal(compiled.confirmable, true, `${where}: Generate agrees`);
      const bound = await bindAllocation(i, final, assignments, {publicationId: `${month}-v${t.versions[month].length + 1}-${k}`, sourceKey: `publish/${month}/${k}`, actor: 'manager'});
      assert.equal(bound.bindable && bound.publishable, true, `${where}: publish (${bound.diagnostics.at(-1)?.code})`);
      t.events = bound.preview.events; t.at = i.now;
      t.versions[month].push({draft: final, plan: compiled.plan});
      t.counted[month] = effect(compiled.plan);
      count(t, t.versions[month].length > 1 ? 're-planned' : 'published');
      checkLedger(t, `${where} published`);
      if (r() < 0.15 && t.versions[month].length === 1) deleteOnly(t, month, where);
    }
    for (const [key, n] of Object.entries(t.stats)) totals[key] = (totals[key] ?? 0) + n;
  }
  console.log(JSON.stringify(totals));
  assert.ok((totals['re-planned'] ?? 0) > 0 && (totals.published ?? 0) > 0);
});

/** Deleting a month's only version cancels its repayments; its own temporary work stays live until a new plan replaces it. */
function deleteOnly(t, month, where) {
  const last = t.versions[month].at(-1);
  const current = project(t.events, t.at, t.at).actual.publications.find(p => p.month === month);
  t.at += 1000;
  t.events = record(t.events, {operation: {kind: 'publication', month, beforeId: current.id, after: null, mode: 'delete'},
    sourceKey: `delete/${month}/${t.at}`, at: t.at, actor: 'manager'}).events;
  t.counted[month] = effect(last.plan, false);
  t.versions[month] = [];
  count(t, 'deleted');
  checkLedger(t, `${where} deleted`);
}
