import {replay, project} from '../compensation/index.ts';
import type {CompensationEvent} from '../compensation/types.ts';
import type {AllocationDraft, AllocationInput} from '../allocation/types.ts';
import {persistedDraft} from '../allocation/edits.ts';
import type {Approval, GenerationInput, Neighbor, Member} from '../scheduling/types.ts';
import {canonicalDuties, coverageStart, halfUnits} from '../scheduling/calendar.ts';
import {addDays, dayOf} from '../rota/calendar-dates.ts';
import type {PrimaryAssignments} from '../scheduling/validate.ts';
import type {DutyClient} from './rpc.ts';
import {assertWritable} from './write-policy.ts';

export type GenerationContext = ReturnType<typeof readGenerationContext>;
type Duty = {id: string; startDate: string; endDate: string; units: number; primary: string | null;
  secondary: string | null; title: string; extra: number; weekendId: string | null};
type Envelope = {revision: number; fingerprint: string; accountingFingerprint: string; actualAtMs: number;
  coverageStartMs: number; generationAllowed: boolean; actual: {events: CompensationEvent[]};
  facts: {month: string; duties: Duty[]; members: Member[]; seniority: string[]; neighbors: Neighbor[];
    constraints: NonNullable<GenerationInput['constraints']>; allocation: AllocationDraft | null;
    allocationId: string | null; sourcePublicationId: string | null; generation: unknown;
    locks: NonNullable<GenerationInput['locks']>; approvals: Approval[]}};
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const string = (v: unknown): v is string => typeof v === 'string';
const nullableString = (v: unknown) => v === null || string(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(string);

/** A separate manager-only read model. Never use the calendar's draft projection
 * for boundary facts; it can hide a neighbor's still-binding live publication. */
export function readGenerationContext(value: unknown) {
  if (!object(value) || !integer(value.revision) || value.revision < 0 || !string(value.fingerprint) ||
    !string(value.accountingFingerprint) || !integer(value.actualAtMs) || !integer(value.coverageStartMs) ||
    typeof value.generationAllowed !== 'boolean' || !object(value.actual) || !Array.isArray(value.actual.events) ||
    !object(value.facts)) throw Error('Invalid generation context');
  const f = value.facts;
  if (!string(f.month) || !Array.isArray(f.duties) || !f.duties.length || !Array.isArray(f.members) ||
    !strings(f.seniority) || !Array.isArray(f.neighbors) || !Array.isArray(f.locks) || !Array.isArray(f.approvals) ||
    !object(f.constraints) || !nullableString(f.allocationId) || !nullableString(f.sourcePublicationId) ||
    !(f.allocation === null || object(f.allocation)) ||
    f.duties.some(d => !object(d) || !string(d.id) || !string(d.startDate) || !string(d.endDate) || !integer(d.units) ||
      !nullableString(d.primary) || !nullableString(d.secondary) || !string(d.title) || typeof d.extra !== 'number' || !nullableString(d.weekendId)) ||
    f.members.some(m => !object(m) || !string(m.id) || ['active', 'approved', 'eligible'].some(k => typeof m[k] !== 'boolean')) ||
    f.neighbors.some(n => !object(n) || ['id', 'ownerMonth', 'start', 'end', 'engineer'].some(k => !string(n[k])) || !['published', 'working'].includes(String(n.source))) ||
    f.locks.some(l => !object(l) || !string(l.dutyId) || !string(l.engineer)) ||
    f.approvals.some(a => !object(a) || !string(a.reason) || !['availability', 'consecutive', 'boundary', 'weekends'].includes(String(a.rule)))) throw Error('Invalid generation facts');
  // Freeze before handing the response to pure engine/planner callers.
  const raw = structuredClone(value) as Envelope, facts = raw.facts;
  const calendar: GenerationInput['calendar'] = {specials: [], splitWeekends: []};
  for (const d of facts.duties) {
    halfUnits(d.extra);
    if (d.title || d.extra) calendar.specials!.push({id: d.id, start: d.startDate, end: d.endDate, extra: d.extra});
    if ([5, 6].includes(dayOf(d.startDate)) && d.endDate === addDays(d.startDate, 1)) {
      const friday = dayOf(d.startDate) === 5 ? d.startDate : addDays(d.startDate, -1);
      if (!calendar.splitWeekends!.includes(friday)) calendar.splitWeekends!.push(friday);
    }
  }
  const duties = canonicalDuties(facts.month, calendar);
  if (duties.length !== facts.duties.length || duties.some((d, i) => d.id !== facts.duties[i].id ||
    d.endDate !== facts.duties[i].endDate || d.units !== facts.duties[i].units) ||
    coverageStart(facts.month, calendar) !== raw.coverageStartMs || raw.generationAllowed !== (raw.actualAtMs < raw.coverageStartMs)) throw Error('Noncanonical generation context');
  const actual = replay(raw.actual.events);
  const input: AllocationInput = {schedule: {month: facts.month, sourceRevision: String(raw.revision), calendar,
    members: facts.members, constraints: facts.constraints, neighbors: facts.neighbors, locks: facts.locks,
    approvals: facts.approvals, secondary: Object.fromEntries(facts.duties.flatMap(d => d.secondary ? [[d.id, d.secondary]] : []))},
  seniority: facts.seniority, events: actual.events, now: raw.actualAtMs};
  const generationInput: GenerationInput | null = facts.allocation === null ? null : {...input.schedule,
    targets: Object.fromEntries(Object.entries(facts.allocation.targetsUnits).map(([id, units]) => [id, units / 2]))};
  return {revision: raw.revision, fingerprint: raw.fingerprint, accountingFingerprint: raw.accountingFingerprint,
    actualAtMs: raw.actualAtMs, coverageStartMs: raw.coverageStartMs, generationAllowed: raw.generationAllowed,
    input, generationInput, actual, projected: project(actual.events, raw.actualAtMs, Math.max(raw.actualAtMs, raw.coverageStartMs)).projected,
    allocation: facts.allocation, allocationId: facts.allocationId, sourcePublicationId: facts.sourcePublicationId,
    generation: facts.generation, assignments: Object.fromEntries(facts.duties.map(d => [d.id,
      {primary: d.primary, ...(d.secondary ? {secondary: d.secondary} : {})}])) as PrimaryAssignments};
}

export async function generationContext(client: DutyClient, month: string, capturedRevision: number) {
  assertWritable(client); // Context may lazily persist earned contributions.
  const {data, error} = await client.rpc('duty_generation_context', {p_month: month, p_revision: capturedRevision});
  if (error) throw error;
  return readGenerationContext(data);
}
export async function confirmAllocation(client: DutyClient, captured: GenerationContext, allocation: AllocationDraft,
  locks?: NonNullable<GenerationInput['locks']>, approvals?: Approval[]) {
  assertWritable(client);
  const {data, error} = await client.rpc('duty_confirm_allocation', {p_month: captured.input.schedule.month,
    p_allocation: persistedDraft(allocation), p_locks: locks ?? captured.input.schedule.locks ?? [],
    p_approvals: approvals ?? captured.input.schedule.approvals ?? [], p_revision: captured.revision, p_fingerprint: captured.fingerprint});
  if (error) throw error;
  return readGenerationContext(data);
}
/** Always use the context captured BEFORE solving. Never retry a stale result
 * with a newer workspace revision or silently accept changed target numbers. */
export async function saveGeneration(client: DutyClient, captured: GenerationContext, assignments: PrimaryAssignments, seed: number) {
  assertWritable(client);
  const {data, error} = await client.rpc('duty_save_generation', {p_month: captured.input.schedule.month,
    p_assignments: assignments, p_revision: captured.revision, p_fingerprint: captured.fingerprint, p_seed: seed});
  if (error) throw error;
  return readGenerationContext(data);
}
