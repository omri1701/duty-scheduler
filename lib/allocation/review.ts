import {context} from './model.ts';
import {permanentCeiling, permanentFloor, validateDraft} from './edits.ts';
import {unevenTransfers} from './planner.ts';
import {canonicalDuties} from '../scheduling/calendar.ts';
import {inputKey} from '../scheduling/domain.ts';
import type {AllocationDraft, AllocationInput, Change} from './types.ts';
import type {Approval, GenerationInput} from '../scheduling/types.ts';
import type {PrimaryAssignments} from '../scheduling/validate.ts';

/** Refresh source identity only after checking the original numbers and sources.
 * This never calculates a proposal or repairs/changes a manager target. */
export function reviewAllocation(input: AllocationInput, saved: AllocationDraft) {
  const c = context(input), draft = {...structuredClone(saved), sourceKey: c.key};
  // Uneven-month credit is derived, never chosen: it is refreshed with the source
  // identity, so a seniority reorder after confirmation re-pairs the credit under
  // the current order instead of trapping the month.
  if (draft.changes && typeof draft.changes === 'object' && draft.baselineUnits && typeof draft.baselineUnits === 'object') {
    draft.uneven = unevenTransfers(input.seniority, c.prepared.duties.map(d => d.units), draft.baselineUnits, draft.changes);
  }
  validateDraft(c, input.seniority, draft);
  return draft;
}

/** A member's net change. A copied snapshot from before per-person changes
 * (display only; the checked RPC revalidates it) is read from its transfers. */
export function changeOf(draft: Pick<AllocationDraft, 'changes' | 'transfers'> | null, id: string): Change {
  if (draft?.changes?.[id]) return {...draft.changes[id]};
  const change: Change = {temporary: 0, permanent: 0};
  for (const t of draft?.transfers ?? []) if (t.toId === id || t.fromId === id) change[t.kind] += t.toId === id ? t.units : -t.units;
  return change;
}

export function allocationTotals(input: AllocationInput, draft: AllocationDraft | null, assignments: PrimaryAssignments) {
  const duties = canonicalDuties(input.schedule.month, input.schedule.calendar), total = duties.reduce((n, d) => n + d.units, 0);
  const rows = input.seniority.map(id => {
    const assigned = duties.reduce((n, d) => n + (assignments[d.id]?.primary === id ? d.units : 0), 0);
    const locked = duties.reduce((n, d) => n + (input.schedule.locks?.some(l => l.dutyId === d.id && l.engineer === id) ? d.units : 0), 0);
    const {temporary, permanent} = changeOf(draft, id), target = draft?.targetsUnits[id] ?? 0;
    const permanentMin = draft?.baselineUnits && draft.offeredUnits ? permanentFloor(draft, id) : 0;
    const permanentMax = draft?.baselineUnits ? permanentCeiling(total, draft, id) : total;
    return {id, target, assigned, locked, temporary, permanent, permanentMin, permanentMax, generate: target - locked, missing: Math.max(0, target - assigned)};
  });
  return {rows, total, configured: rows.reduce((n, r) => n + r.target, 0),
    uncovered: duties.filter(d => !assignments[d.id]?.primary).flatMap(d => d.dates)};
}

/** Exact fixed scopes for an explicit lock review. These are suggestions only;
 * each requires the manager's own reason/approval before becoming an input. */
type WithoutReason<T> = T extends unknown ? Omit<T, 'reason'> : never;
export type ApprovalScope = WithoutReason<Approval>;
/** PostgreSQL JSONB can reorder keys. Scope identity must survive that round trip. */
export const approvalScopeKey = (approval: ApprovalScope | Approval) => inputKey({...approval, reason: undefined});
export function lockExceptions(schedule: AllocationInput['schedule'], locks: NonNullable<GenerationInput['locks']>): ApprovalScope[] {
  const duties = canonicalDuties(schedule.month, schedule.calendar), result: ApprovalScope[] = [];
  for (const l of locks) {
    const d = duties.find(d => d.id === l.dutyId);
    if (!d) continue;
    const dates = d.dates.filter(date => schedule.constraints?.[l.engineer]?.[date] === 'no');
    if (dates.length) result.push({rule: 'availability', dutyId: d.id, engineer: l.engineer, dates} as Approval);
    for (const n of schedule.neighbors ?? []) if (n.engineer === l.engineer && (n.end === d.startDate || n.start === d.endDate)) {
      result.push({rule: 'boundary', dutyId: d.id, neighborId: n.id} as Approval);
    }
    for (const other of locks) {
      const next = duties.find(d => d.id === other.dutyId);
      if (other.engineer === l.engineer && next && d.endDate === next.startDate) result.push({rule: 'consecutive', duties: [d.id, next.id]} as Approval);
    }
  }
  for (const id of new Set(locks.map(l => l.engineer))) {
    const weekends = [...new Set(duties.filter(d => d.weekendId && locks.some(l => l.dutyId === d.id && l.engineer === id)).map(d => d.weekendId!))].sort();
    if (weekends.length > 1) result.push({rule: 'weekends', engineer: id, weekends} as Approval);
  }
  return result;
}
