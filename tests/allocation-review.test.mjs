import test from 'node:test';
import assert from 'node:assert/strict';
import {monthScenario} from './fixtures/generation.mjs';
import {allocationTotals, approvalScopeKey, copyFits, lockExceptions, reviewAllocation} from '../lib/allocation/review.ts';
import {proposeAllocation, retainedChanges} from '../lib/allocation/planner.ts';
import {editAllocation, persistedDraft} from '../lib/allocation/edits.ts';
import {prepareGeneration} from '../lib/scheduling/domain.ts';
import {canonicalDuties, coverageStart} from '../lib/scheduling/calendar.ts';
import {demo, blocks, totals, weekendCounts} from '../lib/rota/engine.ts';
import {workspaceMetrics} from '../lib/rota/workspace-data.ts';

function fixture() {
  const {input: {targets, ...schedule}, witness, now} = monthScenario('normal');
  const input = {schedule, now, events: [], seniority: schedule.members.map(m => m.id)};
  const baselineUnits = Object.fromEntries(Object.entries(targets).map(([id, p]) => [id, p * 2]));
  const changes = Object.fromEntries(input.seniority.map(id => [id, {temporary: 0, permanent: 0}]));
  const draft = {baselineUnits, offeredUnits: {...baselineUnits}, targetsUnits: {...baselineUnits}, repayments: [], changes, pairs: [], transfers: [], sourceKey: 'stored-review'};
  return {input, draft, witness};
}

test('reviewing a new captured revision preserves every confirmed number and original counterpart', () => {
  const {input, draft} = fixture(), original = structuredClone(draft);
  const a = reviewAllocation(input, draft);
  input.schedule.sourceRevision = 'next-accepted-revision';
  const b = reviewAllocation(input, a);
  assert.notEqual(a.sourceKey, b.sourceKey);
  assert.deepEqual(b.targetsUnits, original.targetsUnits);
  assert.deepEqual(b.baselineUnits, original.baselineUnits);
  assert.deepEqual(draft, original);
  input.schedule.members.pop(); input.seniority.pop();
  assert.throws(() => reviewAllocation(input, b), /invalid-allocation-members/);
});

test('an unplaced change stays visible and cannot masquerade as structurally balanced targets', () => {
  const {input, draft} = fixture(), id = input.seniority[0];
  draft.targetsUnits[id] -= 1; draft.changes[id].temporary -= 1;
  const reviewed = reviewAllocation(input, draft);
  const display = allocationTotals(input, reviewed, {});
  assert.equal(display.configured, display.total - 1);
  assert.equal(display.rows.find(r => r.id === id).target, draft.targetsUnits[id]);
  assert.equal(display.rows.find(r => r.id === id).temporary, -1);
  assert.throws(() => prepareGeneration({...input.schedule, targets: Object.fromEntries(Object.entries(reviewed.targetsUnits).map(([id, u]) => [id, u / 2]))}), /target-total-mismatch/);
});

test('manual allocation review after opening never projects actual accounting backwards or changes targets', () => {
  const {input, draft} = fixture();
  input.now = coverageStart(input.schedule.month, input.schedule.calendar) + 1000;
  const reviewed = reviewAllocation(input, draft);
  assert.deepEqual(reviewed.targetsUnits, draft.targetsUnits);
});

test('actual assignments determine missing points, half-unit totals and uncovered dates', () => {
  const {input, draft, witness} = fixture(), duties = canonicalDuties(input.schedule.month, input.schedule.calendar);
  const weekend = duties.find(d => d.weekendId), id = witness[weekend.id].primary;
  input.schedule.secondary = {[weekend.id]: input.seniority.find(e => e !== id)};
  input.schedule.locks = [{dutyId: duties[0].id, engineer: witness[duties[0].id].primary}];
  const actual = {...witness, [weekend.id]: {primary: null, secondary: input.schedule.secondary[weekend.id]}};
  const display = allocationTotals(input, draft, actual);
  assert.deepEqual(display.uncovered, weekend.dates);
  assert.equal(display.rows.reduce((n, r) => n + r.missing, 0), weekend.units);
  assert.equal(display.rows.find(r => r.id === id).missing, weekend.units);
  assert.equal(display.rows.reduce((n, r) => n + r.locked, 0), duties[0].units);
  assert.deepEqual(display.rows.map(r => r.id), input.seniority);
});

test('lock exceptions name only exact unavailable dates, locked pairs, weekends and neighboring sources', () => {
  const {input} = fixture(), e = input.seniority[0];
  input.schedule.constraints = {[e]: {'2026-11-06': 'no', '2026-11-07': 'no'}};
  input.schedule.neighbors = [{id: 'live-oct', engineer: e, ownerMonth: '2026-10', start: '2026-10-30', end: '2026-11-01', source: 'published'}];
  const locks = ['2026-11-01', '2026-11-05', '2026-11-06', '2026-11-13'].map(dutyId => ({dutyId, engineer: e}));
  const scopes = lockExceptions(input.schedule, locks);
  assert.deepEqual(scopes.find(s => s.rule === 'availability'), {rule: 'availability', dutyId: '2026-11-06', engineer: e, dates: ['2026-11-06', '2026-11-07']});
  assert.deepEqual(scopes.find(s => s.rule === 'consecutive'), {rule: 'consecutive', duties: ['2026-11-05', '2026-11-06']});
  assert.deepEqual(scopes.find(s => s.rule === 'weekends').weekends, ['2026-11-06', '2026-11-13']);
  assert.equal(scopes.find(s => s.rule === 'boundary').neighborId, 'live-oct');
  assert.ok(scopes.every(s => !Object.hasOwn(s, 'reason')));
});

test('approval scope identity survives JSONB key and date ordering without granting broader scope', () => {
  const approval = {rule: 'availability', dutyId: '2026-11-06', engineer: 'e00', dates: ['2026-11-06', '2026-11-07'], reason: 'Reviewed'};
  const reordered = {...Object.fromEntries(Object.entries(approval).reverse()), dates: [...approval.dates].reverse()};
  assert.equal(approvalScopeKey(approval), approvalScopeKey(reordered));
  assert.notEqual(approvalScopeKey(approval), approvalScopeKey({...approval, dutyId: '2026-11-13'}));
  assert.notEqual(approvalScopeKey(approval), approvalScopeKey({...approval, engineer: 'e01'}));
});

test('emergency coverage contributes no primary points, weekends or consecutive warnings', () => {
  const s = demo(); s.specials = []; s.assignments = {'2026-11-05': {primary: 'e0'}, '2026-11-06': {primary: 'e1', secondary: 'e0'}};
  const bs = blocks('2026-11', []), metrics = workspaceMetrics(s, '2026-11', bs);
  assert.equal(totals(s, bs).e0, 1); assert.equal(weekendCounts(s, '2026-11').e0, 0);
  assert.deepEqual(metrics.gaps.filter(g => g.p.id === 'e0'), []);
  assert.equal(s.assignments['2026-11-06'].secondary, 'e0');
});

/** What opening Plan the month does with a stored copy of a publication (adopt): a copy
 * that still fits keeps its provenance; any other is replaced by a fresh proposal. */
const opened = (input, copy) => {
  if (copyFits(input, copy)) return {draft: copy, kept: true};
  try {return {draft: reviewAllocation(input, copy), kept: false};}
  catch {return {draft: proposeAllocation(input, retainedChanges(copy)).draft, kept: false};}
};
const targets = (draft) => Object.fromEntries(Object.entries(draft.targetsUnits).map(([id, u]) => [id, u / 2]));
const sum = (t) => Object.values(t).reduce((a, b) => a + b, 0);

test('a copied plan that still fits keeps its stored provenance exactly', () => {
  const {input} = fixture();
  const copy = {...persistedDraft(proposeAllocation(input).draft), sourceKey: 'published-ledger'}, original = structuredClone(copy);
  assert.equal(copyFits(input, copy), true);
  const {draft, kept} = opened(input, copy);
  assert.equal(kept, true); assert.equal(draft, copy); assert.deepEqual(draft, original, 'provenance and numbers untouched');
});

test('a restored copy from an old team, with a deleted source and an earlier format, is replaced by a working proposal', () => {
  // The hosted December: 4 members of an old team (one still active), old keys only.
  const {input} = fixture(), [still] = input.seniority, total = sum(proposeAllocation(input).draft.targetsUnits);
  const old = {[still]: 12, 'gone-1': 0, 'gone-2': 0, 'gone-3': 0};
  const copy = {pending: [], sourceKey: 'deleted-publication-ledger', transfers: [], repayments: [], offeredUnits: {...old}, targetsUnits: {...old}, baselineUnits: {...old}};
  assert.equal(copyFits(input, copy), false);
  const {draft, kept} = opened(input, copy);
  assert.equal(kept, false);
  assert.deepEqual(Object.keys(draft.targetsUnits).sort(), [...input.seniority].sort());
  assert.equal(sum(draft.targetsUnits), total);
  prepareGeneration({...input.schedule, targets: targets(draft)});
  // + / − work on the replacement, and it reviews as Save would store it.
  const next = editAllocation(input, draft, {engineer: still, deltaUnits: 2, kind: 'temporary'}).draft;
  assert.equal(next.targetsUnits[still], draft.targetsUnits[still] + 2);
  reviewAllocation(input, persistedDraft(next));
});

test('a current-format copy from an old team or another month total is replaced, keeping changes that still fit', () => {
  const {input} = fixture(), [a, b] = input.seniority;
  const fitting = editAllocation(input, proposeAllocation(input).draft, {engineer: a, deltaUnits: 2, kind: 'permanent'}).draft;
  // A member left: the copy names someone no longer on the team.
  const smaller = structuredClone(input); smaller.schedule.members = smaller.schedule.members.filter(m => m.id !== b); smaller.seniority = smaller.seniority.filter(id => id !== b);
  const copy = {...persistedDraft(fitting), sourceKey: 'published-ledger'};
  assert.equal(copyFits(smaller, copy), false);
  const replaced = opened(smaller, copy);
  assert.equal(replaced.kept, false); assert.equal(replaced.draft.changes[a].permanent, 2, 'the hand change still fits and is kept');
  prepareGeneration({...smaller.schedule, targets: targets(replaced.draft)});
  // Same members, but the month's total no longer matches the copy.
  const short = {...copy, targetsUnits: {...copy.targetsUnits, [a]: copy.targetsUnits[a] - 2}};
  assert.equal(copyFits(input, short), false);
  assert.equal(opened(input, short).kept, false);
  // An earlier format with the same members: the confirmed baseline is kept (immutable in the RPC).
  const earlier = {...copy}; delete earlier.changes; delete earlier.pairs;
  assert.equal(copyFits(input, earlier), false);
  assert.deepEqual(opened(input, earlier).draft.baselineUnits, copy.baselineUnits);
});
