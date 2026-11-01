import {assertCurrent, unevenTransfers} from './planner.ts';
import {balanceChanges, deriveTransfers, handOf, isKind, KINDS, zeroChange, type Hand} from './derive.ts';
import {context, sum, units, type Context} from './model.ts';
import type {AllocationDraft, AllocationInput, Change, Kind, Pair, Transfer} from './types.ts';

const signed = (v: unknown): v is number => Number.isSafeInteger(v) && Math.abs(v as number) <= 1e9;
const changeShape = (v: unknown): v is Change => !!v && typeof v === 'object' && Object.keys(v).length === 2 &&
  signed((v as Change).temporary) && signed((v as Change).permanent);

/** The least permanent change a member may carry: a permanent reduction can
 * take away neither the fair share (fair + Permanent >= 0) nor work already
 * given away as planned relief (offered + Permanent >= 0). */
export const permanentFloor = (draft: Pick<AllocationDraft, 'baselineUnits' | 'offeredUnits'>, id: string) =>
  -Math.min(draft.baselineUnits[id], draft.offeredUnits[id]);
/** The most permanent change a member may carry (decision 2026-10-31): the
 * fair share plus the punishment never exceeds the month's total points
 * (fair + Permanent <= total). */
export const permanentCeiling = (total: number, draft: Pick<AllocationDraft, 'baselineUnits'>, id: string) =>
  total - draft.baselineUnits[id];

export function validateDraft(c: Context, seniority: readonly string[], draft: AllocationDraft) {
  assertCurrent(c, draft);
  const table = (t: Record<string, number>) => {
    if (!t || typeof t !== 'object' || Object.keys(t).length !== c.ids.length || c.ids.some(id => !Object.hasOwn(t, id))) throw Error('invalid-allocation-members');
    Object.values(t).forEach(units);
  };
  if (!draft.changes || typeof draft.changes !== 'object' || !Array.isArray(draft.pairs) || !Array.isArray(draft.transfers)) throw Error('invalid-allocation-shape');
  table(draft.baselineUnits); table(draft.offeredUnits); table(draft.targetsUnits);
  if (sum(Object.values(draft.baselineUnits)) !== c.total) throw Error('invalid-baseline-total');
  const expected = {...draft.baselineUnits}, slices = new Map<string, {offset: number; units: number}[]>();
  for (const r of draft.repayments) {
    units(r.units);
    const candidate = c.candidates.find(c => c.debtorId === r.claim.debtorId && c.creditorId === r.claim.creditorId &&
      c.path.length === r.claim.path.length && c.path.every((s, i) => s.lotId === r.claim.path[i].lotId &&
        r.claim.path[i].offset >= s.offset && r.claim.path[i].offset + r.units <= s.offset + s.units &&
        r.claim.path[i].offset - s.offset === r.claim.path[0].offset - c.path[0].offset));
    if (!r.units || !candidate || r.claim.units !== r.units || r.claim.path.some(s => s.units !== r.units) ||
      r.claim.frozen || r.claim.priority.at !== candidate.priority.at || r.claim.priority.sequence !== candidate.priority.sequence ||
      r.claim.priority.lotId !== candidate.priority.lotId) throw Error('invalid-repayment-source');
    for (const s of r.claim.path) {
      const previous = slices.get(s.lotId) ?? [];
      if (previous.some(p => p.offset < s.offset + s.units && s.offset < p.offset + p.units)) throw Error('duplicate-repayment-source');
      slices.set(s.lotId, [...previous, s]);
    }
    expected[r.claim.debtorId] += r.units; expected[r.claim.creditorId] -= r.units;
  }
  if (c.ids.some(id => expected[id] !== draft.offeredUnits[id])) throw Error('invalid-offered-allocation');
  if (Object.keys(draft.changes).length !== c.ids.length || c.ids.some(id => !changeShape(draft.changes[id]))) throw Error('invalid-allocation-changes');
  for (const id of c.ids) {
    if (draft.changes[id].permanent < permanentFloor(draft, id)) throw Error('permanent-below-fair-share');
    if (draft.changes[id].permanent > permanentCeiling(c.total, draft, id)) throw Error('permanent-above-month-total');
    // No one owes, or is owed, more temporary work than the month holds.
    if (Math.abs(draft.changes[id].temporary) > c.total) throw Error('temporary-above-month-total');
    if (draft.offeredUnits[id] + draft.changes[id].permanent + draft.changes[id].temporary !== draft.targetsUnits[id]) throw Error('unexplained-target-edit');
  }
  // A change no one can absorb leaves points unplaced, never more points than the month has.
  if (sum(c.ids.map(id => draft.targetsUnits[id])) > c.total) throw Error('allocation-above-month-total');
  const ids = new Set<string>();
  for (const p of draft.pairs) {
    if (!p || typeof p.id !== 'string' || !p.id.trim() || ids.has(p.id) || !isKind(p.kind) || p.fromId === p.toId ||
      !c.ids.includes(p.fromId) || !c.ids.includes(p.toId) || !Number.isSafeInteger(p.units) || p.units <= 0) throw Error('invalid-allocation-pair');
    ids.add(p.id); units(p.units);
  }
  // Field by field: a snapshot read back from PostgreSQL has its JSON keys reordered.
  const canonical = (t: Transfer) => [t.id, t.fromId, t.toId, t.units, t.kind];
  if (draft.transfers.some(t => !t || typeof t !== 'object' || Object.keys(t).length !== 5) ||
    JSON.stringify(draft.transfers.map(canonical)) !== JSON.stringify(deriveTransfers(seniority, draft.changes, draft.pairs).map(canonical))) throw Error('invalid-derived-transfers');
  // Uneven-month credit is derived too (proposals, edits and review compute it);
  // like the baseline's optimality, its exact set is the checked RPC's decision.
  // A snapshot without it carries none.
  const uneven = draft.uneven ?? [];
  if (!Array.isArray(uneven)) throw Error('invalid-uneven-credit');
  const credits = new Set<string>();
  for (const u of uneven) {
    if (!u || typeof u !== 'object' || Object.keys(u).length !== 4 || u.id !== `uneven/${u.fromId}/${u.toId}` || credits.has(u.id) ||
      !c.ids.includes(u.fromId) || !c.ids.includes(u.toId) || u.fromId === u.toId || !Number.isSafeInteger(u.units) || u.units <= 0) throw Error('invalid-uneven-credit');
    credits.add(u.id); units(u.units);
  }
  if (draft.hand && (!Array.isArray(draft.hand) || new Set(draft.hand).size !== draft.hand.length ||
    draft.hand.some(id => !c.ids.includes(id)))) throw Error('invalid-hand-edits');
}

/** Every change kind sums to zero: the automatic balance placed every hand change. */
export const balanced = (draft: Pick<AllocationDraft, 'changes'>) =>
  KINDS.every(kind => sum(Object.values(draft.changes).map(ch => ch[kind])) === 0);
/** Units of each kind still without a counterpart (positive: more work to place). */
export const unplacedChanges = (draft: Pick<AllocationDraft, 'changes'>): Change =>
  ({temporary: 0 - sum(Object.values(draft.changes).map(ch => ch.temporary)), permanent: 0 - sum(Object.values(draft.changes).map(ch => ch.permanent))});

/** The shape the checked RPC persists. `hand` is kept, so a reopened plan
 * balances automatic points exactly like the session that saved it. */
export function persistedDraft(source: AllocationDraft): AllocationDraft {
  return {...source};
}

const unplacedUnits = (draft: Pick<AllocationDraft, 'changes'>) => {const u = unplacedChanges(draft); return Math.abs(u.temporary) + Math.abs(u.permanent);};

/** Rebuild everything derived from the hand state: automatic balance, targets
 * and the canonical transfer list. */
export function rebuild(c: Context, input: AllocationInput, source: AllocationDraft, hand: Hand, pairs: Pair[]): AllocationDraft {
  const {changes} = balanceChanges(c, input.seniority, source.baselineUnits, source.offeredUnits, hand);
  const targetsUnits = Object.fromEntries(c.ids.map(id => [id, source.offeredUnits[id] + changes[id].temporary + changes[id].permanent]));
  const draft: AllocationDraft = {baselineUnits: {...source.baselineUnits}, offeredUnits: {...source.offeredUnits}, targetsUnits,
    repayments: structuredClone(source.repayments), changes, pairs: structuredClone(pairs),
    transfers: deriveTransfers(input.seniority, changes, pairs),
    uneven: unevenTransfers(input.seniority, c.prepared.duties.map(d => d.units), source.baselineUnits, changes),
    sourceKey: source.sourceKey, hand: Object.keys(hand)};
  validateDraft(c, input.seniority, draft);
  // The configured total always equals the month total: an edit no one can
  // absorb is refused, never left unplaced. (A legacy unbalanced source may only
  // move toward balance.)
  if (!balanced(draft) && (balanced(source) || unplacedUnits(draft) >= unplacedUnits(source))) throw Error('unplaced-allocation-change');
  return draft;
}

/** One signed Temporary/Permanent change on a member. The member's net change
 * of that kind becomes what was shown plus the delta, so a minus on a member
 * who only holds an automatic point removes that point. The member is then
 * hand edited: the automatic balance of both kinds is recomputed from scratch
 * on the other members, never sticking on anyone edited by hand. */
export function editAllocation(input: AllocationInput, source: AllocationDraft, edit: Edit) {
  const c = context(input); validateDraft(c, input.seniority, source);
  const draft = applyEdit(c, input, source, edit);
  return {draft, balanced: balanced(draft), unplaced: unplacedChanges(draft)};
}

/** Which + and − of one step the library accepts, per member and kind, so the
 * dialog disables exactly the edits it would refuse (a floor, the ceiling, or a
 * + that no one else can absorb). */
export function editOptions(input: AllocationInput, source: AllocationDraft, step: number) {
  const c = context(input); validateDraft(c, input.seniority, source);
  const accepts = (edit: Edit) => {try {applyEdit(c, input, source, edit); return true;} catch {return false;}};
  return Object.fromEntries(c.ids.map(id => [id, Object.fromEntries(KINDS.map(kind => [kind,
    {up: accepts({engineer: id, deltaUnits: step, kind}), down: accepts({engineer: id, deltaUnits: -step, kind})}]))])) as
    Record<string, Record<Kind, {up: boolean; down: boolean}>>;
}

type Edit = {engineer: string; deltaUnits: number; kind: Kind};
function applyEdit(c: Context, input: AllocationInput, source: AllocationDraft, edit: Edit) {
  if (!c.ids.includes(edit.engineer) || !isKind(edit.kind) || !Number.isSafeInteger(edit.deltaUnits) || !edit.deltaUnits) throw Error('invalid-allocation-edit');
  units(Math.abs(edit.deltaUnits));
  const hand = handOf(source), current = source.changes[edit.engineer];
  const next = {...(hand[edit.engineer] ?? zeroChange()), [edit.kind]: current[edit.kind] + edit.deltaUnits};
  if (next.permanent < permanentFloor(source, edit.engineer)) throw Error('permanent-below-fair-share');
  // A whole step that would overshoot the ceiling is refused, never half applied.
  if (next.permanent > permanentCeiling(c.total, source, edit.engineer)) throw Error('permanent-above-month-total');
  if (source.offeredUnits[edit.engineer] + next.temporary + next.permanent < c.locked[edit.engineer]) throw Error('edit-below-locked-points');
  const edited = {...hand, [edit.engineer]: next};
  try {return rebuild(c, input, source, edited, source.pairs);} catch (error) {
    if (!(error instanceof Error) || error.message !== 'unplaced-allocation-change') throw error;
    // No one free can take it, e.g. everyone else dragged their points onto this member
    // (decision 2026-11-01): undo the member's own drags of that kind, newest first, so
    // the points go back to whoever they came from (a − on a receiver, a + on a giver).
    const pairs = structuredClone(source.pairs), back = {...edited};
    let left = Math.abs(edit.deltaUnits);
    for (const p of [...pairs].reverse()) {
      if (!left || p.kind !== edit.kind || (edit.deltaUnits < 0 ? p.toId : p.fromId) !== edit.engineer) continue;
      const n = Math.min(left, p.units), other = edit.deltaUnits < 0 ? p.fromId : p.toId, was = back[other] ?? {...source.changes[other]};
      back[other] = {...was, [edit.kind]: was[edit.kind] + (edit.deltaUnits < 0 ? n : -n)};
      p.units -= n; left -= n;
    }
    if (left) throw error;
    return rebuild(c, input, source, back, pairs.filter(p => p.units));
  }
}

/** One exact manual transfer, such as dragging one member onto another: a
 * temporary pair that routes derived debts from the giver to the receiver.
 * Both members become hand edited; no counterpart is chosen automatically. */
export function transferAllocation(input: AllocationInput, source: AllocationDraft, pair: Pair) {
  const c = context(input); validateDraft(c, input.seniority, source);
  const {id, fromId, toId, units: amount, kind} = pair;
  if (!id?.trim() || source.pairs.some(p => p.id === id) || !c.ids.includes(fromId) || !c.ids.includes(toId) ||
    fromId === toId || !isKind(kind) || !Number.isSafeInteger(amount) || amount <= 0) throw Error('invalid-allocation-edit');
  units(amount);
  const hand = handOf(source);
  const from = {...(hand[fromId] ?? zeroChange()), [kind]: source.changes[fromId][kind] - amount};
  const to = {...(hand[toId] ?? zeroChange()), [kind]: source.changes[toId][kind] + amount};
  if (from.permanent < permanentFloor(source, fromId)) throw Error('permanent-below-fair-share');
  if (to.permanent > permanentCeiling(c.total, source, toId)) throw Error('permanent-above-month-total');
  if (source.offeredUnits[fromId] + from.temporary + from.permanent < c.locked[fromId]) throw Error('edit-below-locked-points');
  const draft = rebuild(c, input, source, {...hand, [fromId]: from, [toId]: to}, [...source.pairs, {id, fromId, toId, units: amount, kind}]);
  return {draft, balanced: balanced(draft), unplaced: unplacedChanges(draft)};
}

/** Reclassifies one pair, e.g. making a dragged temporary point permanent. Both
 * members' net changes move between the kinds; points are unchanged. */
export function classifyTransfer(input: AllocationInput, source: AllocationDraft, id: string, kind: Kind) {
  const c = context(input); validateDraft(c, input.seniority, source);
  const pair = source.pairs.find(p => p.id === id);
  if (!pair || !isKind(kind)) throw Error('invalid-allocation-edit');
  if (pair.kind === kind) return structuredClone(source);
  const hand = handOf(source), moved = (member: string, sign: number) => {
    const change = {...(hand[member] ?? zeroChange())};
    change[pair.kind] = source.changes[member][pair.kind] - sign * pair.units;
    change[kind] = source.changes[member][kind] + sign * pair.units;
    return change;
  };
  const from = moved(pair.fromId, -1), to = moved(pair.toId, 1);
  if (from.permanent < permanentFloor(source, pair.fromId)) throw Error('permanent-below-fair-share');
  if (to.permanent > permanentCeiling(c.total, source, pair.toId)) throw Error('permanent-above-month-total');
  return rebuild(c, input, source, {...hand, [pair.fromId]: from, [pair.toId]: to},
    source.pairs.map(p => p.id === id ? {...p, kind} : {...p}));
}
