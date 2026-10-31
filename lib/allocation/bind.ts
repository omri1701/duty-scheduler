import {record, reconcile, repaymentCandidates, sliceClaim} from '../compensation/index.ts';
import {CompensationError, type CapacitySlice, type Publication} from '../compensation/types.ts';
import {snapshotKey} from '../scheduling/domain.ts';
import {canonicalDuties} from '../scheduling/calendar.ts';
import {GenerationError, type Diagnostic} from '../scheduling/types.ts';
import type {PrimaryAssignments} from '../scheduling/validate.ts';
import {compileAllocation} from './compile.ts';
import type {AllocationDraft, AllocationInput} from './types.ts';

export type BindingIdentity = {publicationId: string; sourceKey: string; actor: string; reason?: string};
async function identity(value: unknown) {
  const bytes = new TextEncoder().encode(snapshotKey(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return 'allocation/' + [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('');
}

/** A pure preview, never a write. Partial drafts may bind their assigned work,
 * but publishable remains false. Existing publications require explicit lineage
 * review rather than synthesizing another allocation origin on the same work. */
export async function bindAllocation(source: AllocationInput, allocation: AllocationDraft,
  actual: PrimaryAssignments, identitySource: BindingIdentity) {
  // Freeze the entire request before the asynchronous identity calculation.
  const input = structuredClone(source), draft = structuredClone(allocation), assignments = structuredClone(actual);
  const envelope = structuredClone(identitySource);
  const compiled = compileAllocation(input, draft, assignments);
  const diagnostics: Diagnostic[] = [...compiled.diagnostics];
  const failure = (code: string) => ({...compiled, diagnostics: [...diagnostics, {code, certainty: 'fact' as const}],
    publication: null, preview: null, bindable: false, publishable: false});
  if (!compiled.plan || !compiled.confirmable) return failure('allocation-binding-requires-review');
  if (!envelope.publicationId.trim() || !envelope.sourceKey.trim() || !envelope.actor.trim()) return failure('missing-binding-identity');
  const month = input.schedule.month;
  if (input.events.some(e => e.operation.kind === 'publication' && e.operation.month === month)) {
    return failure('review-existing-publication-lineage');
  }
  const duties = canonicalDuties(month, input.schedule.calendar);
  const publication: Publication = {id: envelope.publicationId, month, duties: duties.flatMap(d => {
    const primaryId = assignments[d.id].primary;
    return primaryId === null ? [] : [{startDate: d.startDate, endDate: d.endDate, primaryId, units: d.units}];
  }), intents: [], reservations: []};
  // A combined weekend's dates carry one unit each plus half of any holiday extra,
  // the odd unit on Friday: the same split as the compensation atoms and a hand split.
  const atoms = duties.flatMap(d => assignments[d.id].primary === null ? [] : d.dates.map((date, k) => ({date,
    primaryId: assignments[d.id].primary!, offset: 0,
    units: d.dates.length === 2 ? 1 + (k === 0 ? Math.ceil((d.units - 2) / 2) : Math.floor((d.units - 2) / 2)) : d.units})));
  const take = (engineer: string, units: number): CapacitySlice[] => {
    const slices: CapacitySlice[] = [];
    for (const a of atoms) {
      if (!units || a.primaryId !== engineer) continue;
      const amount = Math.min(units, a.units - a.offset); if (!amount) continue;
      slices.push({date: a.date, offset: a.offset, units: amount}); a.offset += amount; units -= amount;
    }
    if (units) throw new CompensationError('unbindable-duty-capacity');
    return slices;
  };
  const scope = {version: 'allocation-binding-v1', publicationId: envelope.publicationId,
    sourceKey: envelope.sourceKey, allocationSource: draft.sourceKey};
  try {
    // Transfer routes own one exclusive capacity slice, regardless of the number
    // of intermediate temporary/permanent accounting legs in their history.
    const intents = [] as Publication['intents'][number][];
    for (const f of compiled.plan.funding) {
      const capacity = take(f.carrierId, f.units), first = f.route[0];
      // Uneven-month credit is recorded with the same counterpart shape as a temporary transfer.
      const counterpart = (id: string) => {
        const transfer = draft.transfers.find(t => t.id === id), credit = (draft.uneven ?? []).find(u => u.id === id);
        if (transfer) return transfer;
        if (!credit) throw new CompensationError('unknown-counterpart');
        return {id, fromId: credit.fromId, toId: credit.toId, units: credit.units, kind: 'temporary' as const};
      };
      const route = f.route.map(({units, normalizedDeferredClaims, ...leg}) => {
        void units; void normalizedDeferredClaims;
        return {...leg, counterparts: leg.transferIds.map(id => structuredClone(counterpart(id)))};
      });
      const data = {kind: first.kind, fromId: first.fromId, toId: f.carrierId, capacity, route};
      intents.push({id: await identity({scope, intent: data}), ...data});
    }
    publication.intents = intents;
    const command = (after: Publication) => ({sourceKey: envelope.sourceKey, actor: envelope.actor,
      reason: envelope.reason, at: input.now,
      operation: {kind: 'publication' as const, month, beforeId: null, after}});
    // Use the authoritative transition, with its real lot IDs/order, before
    // selecting reservations. A planner-only normalization is not that proof.
    const transferred = record(input.events, command(publication));
    const before = reconcile(input.events, input.now);
    if (before.contributions.some(c => c.status === 'pending' && transferred.contributions.some(next =>
      next.id === c.id && next.status === 'held' && next.holdReason === 'claim-changed'))) {
      return failure('review-existing-reservation-normalization');
    }
    const available = repaymentCandidates(transferred.events);
    const reservations = [] as Publication['reservations'][number][];
    for (const r of compiled.plan.repayments) {
      const sourceClaim = available.find(c => c.debtorId === r.claim.debtorId && c.creditorId === r.claim.creditorId &&
        c.path.length === r.claim.path.length && c.path.every((s, i) => s.lotId === r.claim.path[i].lotId &&
          r.claim.path[i].offset >= s.offset && r.claim.path[i].offset + r.units <= s.offset + s.units &&
          r.claim.path[i].offset - s.offset === r.claim.path[0].offset - c.path[0].offset));
      if (!sourceClaim) return failure('review-publication-repayment-source');
      let offset = 0;
      for (const capacity of take(r.claim.debtorId, r.units)) {
        const claim = sliceClaim(r.claim, capacity.units, offset); offset += capacity.units;
        reservations.push({id: await identity({scope, capacity, claim}), capacity, claim});
      }
    }
    publication.reservations = reservations;
    const preview = record(input.events, command(publication));
    return {...compiled, diagnostics, publication, preview, bindable: true,
      publishable: compiled.check?.feasibility === 'complete'};
  } catch (error) {
    if (error instanceof CompensationError || error instanceof GenerationError) return failure(`publication-binding:${error.code}`);
    throw error;
  }
}
