import type {Settings, SolverAdapter} from '../scheduling/solver/highs-adapter.ts';
import {assertCurrent} from './planner.ts';
import {budget, checkTargets, context, sum, units, type Context} from './model.ts';
import type {AllocationDraft, AllocationInput, Kind, Pending, Transfer} from './types.ts';

export function validateDraft(c: Context, draft: AllocationDraft) {
  assertCurrent(c, draft);
  const table = (t: Record<string, number>) => {
    if (Object.keys(t).length !== c.ids.length || c.ids.some(id => !Object.hasOwn(t, id))) throw Error('invalid-allocation-members');
    Object.values(t).forEach(units);
  };
  table(draft.baselineUnits); table(draft.offeredUnits); table(draft.targetsUnits);
  if (sum(Object.values(draft.baselineUnits)) !== c.total) throw Error('invalid-baseline-total');
  const expected = {...draft.baselineUnits}, slices = new Map<string, {offset: number; units: number}[]>();
  for (const r of draft.repayments) {
    units(r.units);
    const candidate = c.candidates.find(c => c.debtorId === r.claim.debtorId && c.creditorId === r.claim.creditorId &&
      c.path.length === r.claim.path.length && c.path.every((s, i) => s.lotId === r.claim.path[i].lotId &&
        r.claim.path[i].offset >= s.offset && r.claim.path[i].offset + r.units <= s.offset + s.units));
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
  const ids = new Set<string>();
  const identity = (id: string, kind: Kind) => {
    if (!id?.trim() || ids.has(id) || !['temporary', 'permanent'].includes(kind)) throw Error('invalid-transfer-identity');
    ids.add(id);
  };
  for (const t of draft.transfers) {
    identity(t.id, t.kind); units(t.units);
    if (!t.units || t.fromId === t.toId || !c.ids.includes(t.fromId) || !c.ids.includes(t.toId)) throw Error('invalid-counterpart');
    expected[t.fromId] -= t.units; expected[t.toId] += t.units;
  }
  for (const p of draft.pending) {
    identity(p.id, p.kind);
    if (!c.ids.includes(p.engineer) || !Number.isSafeInteger(p.deltaUnits) || !p.deltaUnits) throw Error('invalid-pending-edit');
    units(Math.abs(p.deltaUnits)); expected[p.engineer] += p.deltaUnits;
  }
  if (c.ids.some(id => expected[id] !== draft.targetsUnits[id])) throw Error('unexplained-target-edit');
}

/** Applies one signed Target/Permanent edit, preserving the requested ceiling.
 * Returning pending work is intentional; it requires explicit counterpart edits. */
export function editAllocation(adapter: SolverAdapter, input: AllocationInput, source: AllocationDraft,
  edit: {id: string; engineer: string; deltaUnits: number; kind: Kind}, settings: Partial<Settings> = {}) {
  const c = context(input); validateDraft(c, source);
  if (!edit.id?.trim() || source.transfers.some(t => t.id.startsWith(`${edit.id}/`)) ||
    source.pending.some(p => p.id.startsWith(`${edit.id}/`)) || !c.ids.includes(edit.engineer) ||
    !['temporary', 'permanent'].includes(edit.kind) || !Number.isSafeInteger(edit.deltaUnits) || !edit.deltaUnits) throw Error('invalid-allocation-edit');
  units(Math.abs(edit.deltaUnits));
  const draft = structuredClone(source), work = budget(settings), diagnostics = [] as ReturnType<typeof checkTargets>['diagnostics'];
  const next = draft.targetsUnits[edit.engineer] + edit.deltaUnits;
  if (next < c.locked[edit.engineer]) throw Error('edit-below-locked-points');
  units(next); draft.targetsUnits[edit.engineer] = next;
  let remaining = edit.deltaUnits, serial = 0;
  const transfer = (fromId: string, toId: string, amount: number, kind: Kind) => {
    const t: Transfer = {id: `${edit.id}/${serial++}`, fromId, toId, units: amount, kind}; draft.transfers.push(t);
  };
  // Explicit counterpart controls can finish an earlier unbalanced edit, even
  // when its knowingly partial target is unsuitable for automatic selection.
  for (const p of draft.pending) {
    if (!remaining || p.kind !== edit.kind || Math.sign(p.deltaUnits) === Math.sign(remaining)) continue;
    const amount = Math.min(Math.abs(remaining), Math.abs(p.deltaUnits));
    if (p.engineer !== edit.engineer) {
      if (remaining > 0) transfer(p.engineer, edit.engineer, amount, p.kind);
      else transfer(edit.engineer, p.engineer, amount, p.kind);
    }
    p.deltaUnits += Math.sign(remaining) * amount; remaining -= Math.sign(remaining) * amount;
  }
  draft.pending = draft.pending.filter(p => p.deltaUnits);
  const rank = (id: string) => input.seniority.indexOf(id);
  const candidates = () => c.ids.filter(id => id !== edit.engineer).sort((a, b) => {
    if (remaining > 0) return draft.targetsUnits[b] - draft.targetsUnits[a] || rank(a) - rank(b);
    if (edit.kind === 'permanent') return draft.targetsUnits[a] - draft.targetsUnits[b] || rank(b) - rank(a);
    const pos = rank(edit.engineer), distance = (id: string) => (rank(id) - pos + c.ids.length) % c.ids.length;
    return distance(a) - distance(b);
  });
  const tryAmount = (counterpart: string, amount: number) => {
    const direction = Math.sign(remaining), current = {...draft.targetsUnits};
    current[edit.engineer] -= remaining; // intermediate probe only; output keeps the requested limit
    const candidate = {...current}; candidate[edit.engineer] += direction * amount; candidate[counterpart] -= direction * amount;
    if (candidate[counterpart] < c.locked[counterpart]) return false;
    const before = checkTargets(adapter, c, current, work);
    const recipient = direction > 0 ? edit.engineer : counterpart;
    const floor = (before.actualUnits[recipient] ?? current[recipient]) + amount;
    const after = checkTargets(adapter, c, candidate, work, {[recipient]: floor});
    const safe = after.feasibility === 'complete' || (before.feasibility === 'partial' &&
      after.feasibility === 'partial' && after.coverage >= before.coverage &&
      (after.coverage > before.coverage || after.special >= before.special) &&
      (after.coverage > before.coverage || after.special > before.special || after.assignedUnits >= before.assignedUnits));
    if (!safe) {
      if (after.feasibility === 'unknown' || before.feasibility === 'unknown') diagnostics.push({code: 'counterpart-feasibility-unproved', certainty: 'unproved', engineer: counterpart});
      return false;
    }
    if (direction > 0) transfer(counterpart, edit.engineer, amount, edit.kind);
    else transfer(edit.engineer, counterpart, amount, edit.kind);
    draft.targetsUnits[counterpart] -= direction * amount; remaining -= direction * amount;
    return true;
  };
  if (!draft.pending.length && remaining) {
    // Whole request first, then exact half-point units with ranking refreshed.
    for (const id of candidates()) if (tryAmount(id, Math.abs(remaining))) break;
    while (remaining && work.next().seconds > 0) {
      let placed = false;
      for (const id of candidates()) if (tryAmount(id, 1)) {placed = true; break;}
      if (!placed) break;
    }
  }
  if (remaining) {
    const p: Pending = {id: `${edit.id}/${serial}`, engineer: edit.engineer, deltaUnits: remaining, kind: edit.kind}; draft.pending.push(p);
    diagnostics.push({code: 'place-pending-counterpart-units', certainty: 'fact', engineer: edit.engineer, units: Math.abs(remaining)});
  }
  validateDraft(c, draft);
  return {draft, diagnostics, balanced: !draft.pending.length && sum(Object.values(draft.targetsUnits)) === c.total};
}
