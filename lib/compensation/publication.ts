import {addDays, dayOf} from '../rota/calendar-dates.ts';
import {handover, requireDate} from '../scheduling/calendar.ts';
import {compareId, normalize, segment, units} from './normalize.ts';
import {addLot, endpoints, fail, fingerprint, locate, reserve, type State} from './state.ts';
import type {CapacitySlice, CompensationEvent, Publication, Reservation} from './types.ts';

type Atom = {date: string; units: number; primaryId: string; endInstantMs: number};
const owner = (date: string) => (dayOf(date) === 6 ? addDays(date, -1) : date).slice(0, 7);
function atoms(s: State, publication: Publication) {
  if (!publication.id || !/^\d{4}-\d{2}$/.test(publication.month)) fail('invalid-publication');
  requireDate(publication.month + '-01');
  const result = new Map<string, Atom>();
  for (const d of [...publication.duties].sort((a, b) => compareId(a.startDate, b.startDate))) {
    requireDate(d.startDate); requireDate(d.endDate); units(d.units, true);
    const combined = d.endDate === addDays(d.startDate, 2) && dayOf(d.startDate) === 5;
    const base = combined || ![5, 6].includes(dayOf(d.startDate)) ? 2 : 1;
    if (!s.members.has(d.primaryId) || owner(d.startDate) !== publication.month ||
      (!combined && (d.endDate !== addDays(d.startDate, 1) || d.saturdayUnits !== undefined))) fail('invalid-published-duty');
    if (d.units < base || d.units > (combined ? 82 : base + 40)) fail('invalid-published-duty-weight');
    // A combined weekend has one atom per date, each carrying its own date's points:
    // Saturday its saturdayUnits (one plus twice its extra), Friday the rest.
    const saturday = combined ? d.saturdayUnits ?? 1 : 0;
    if (combined && (!Number.isSafeInteger(saturday) || saturday < 1 || saturday > 41 || d.units - saturday < 1 || d.units - saturday > 41)) fail('invalid-published-duty-weight');
    for (let date = d.startDate; date < d.endDate; date = addDays(date, 1)) {
      if (result.has(date)) fail('overlapping-published-duty');
      const amount = combined ? (date === d.startDate ? d.units - saturday : saturday) : d.units;
      result.set(date, {date, units: amount, primaryId: d.primaryId, endInstantMs: handover(d.endDate) * 60000});
    }
  }
  return result;
}
function capacity(atom: Atom | undefined, slice: CapacitySlice) {
  units(slice.offset); units(slice.units, true);
  if (!atom || slice.offset + slice.units > atom.units) fail('invalid-capacity-slice');
}
const sameReservation = (a: Reservation, b: Reservation) => fingerprint(a) === fingerprint(b);
const reservationData = (c: Reservation): Reservation => ({id: c.id, capacity: c.capacity, claim: c.claim});
function gaps(start: number, end: number, ranges: readonly [number, number][]) {
  const result: [number, number][] = [];
  let cursor = start;
  for (const [lo, hi] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (cursor < Math.min(lo, end)) result.push([cursor, Math.min(lo, end)]);
    cursor = Math.max(cursor, hi);
  }
  if (cursor < end) result.push([cursor, end]);
  return result;
}

/** Processes only a checked authoritative transition, never draft/display snapshots. */
export function transition(s: State, event: CompensationEvent, op: Extract<CompensationEvent['operation'], {kind: 'publication'}>) {
  if (!/^\d{4}-\d{2}$/.test(op.month)) fail('invalid-publication-month');
  requireDate(op.month + '-01');
  const before = s.publications.get(op.month), after = op.after;
  if ((before?.id ?? null) !== op.beforeId || (after && after.month !== op.month)) fail('stale-publication');
  const known = after && s.events.find(e => e.operation.kind === 'publication' && e.operation.after?.id === after.id);
  if (known && known.operation.kind === 'publication' && fingerprint(known.operation.after) !== fingerprint(after)) fail('immutable-publication');
  if (op.mode && (op.mode !== 'delete' || !before || (after && (!known || after.id === before.id)))) fail('invalid-publication-deletion');
  const old = before ? atoms(s, before) : new Map<string, Atom>(), next = after ? atoms(s, after) : new Map<string, Atom>();
  // Deletion drops the live pointer; it never erases completed facts retained in events.
  if (after && op.mode !== 'delete') for (const [date, a] of old) if (a.endInstantMs <= event.at && fingerprint(a) !== fingerprint(next.get(date))) fail('historical-publication-change');
  const proposed = new Map<string, Reservation>();
  for (const r of [...(after?.reservations ?? [])].sort((a, b) => compareId(a.id, b.id))) {
    if (!r.id || proposed.has(r.id)) fail('duplicate-contribution');
    proposed.set(r.id, r); capacity(next.get(r.capacity.date), r.capacity);
    if (next.get(r.capacity.date)!.primaryId !== r.claim.debtorId) fail('reservation-primary-mismatch');
  }
  const excluded = new Map<string, [number, number][]>();
  const exclude = (slice: CapacitySlice) => {
    const ranges = excluded.get(slice.date) ?? [], end = slice.offset + slice.units;
    if (ranges.some(([a, b]) => a < end && slice.offset < b)) fail('overlapping-accounting-capacity');
    ranges.push([slice.offset, end]); excluded.set(slice.date, ranges);
  };
  const effects: {debtorId: string; creditorId: string; units: number}[] = [];
  const permanent = (after?.intents ?? []).filter(i => i.kind === 'permanent' && !s.intents.has(i.id));
  // Classify cancelled repayment before ordinary replacement/weighted-swap deltas.
  for (const oldPlan of [...(before?.reservations ?? [])].sort((a, b) => compareId(a.id, b.id))) {
    const c = s.contributions.get(oldPlan.id)!;
    const a = old.get(c.capacity.date)!, b = next.get(c.capacity.date), proposedPlan = proposed.get(c.id);
    if (proposedPlan && !sameReservation(oldPlan, proposedPlan)) fail('contribution-lineage-changed');
    const unchanged = proposedPlan && b && a.primaryId === b.primaryId && c.capacity.offset + c.capacity.units <= b.units;
    if (unchanged) {
      if (c.status === 'pending' || c.status === 'held') {
        if (b.endInstantMs <= event.at && c.endInstantMs !== b.endInstantMs) fail('historical-repayment-rebind');
        c.endInstantMs = b.endInstantMs;
      }
      continue;
    }
    if (proposedPlan) fail('changed-duty-reuses-contribution');
    if (c.status !== 'pending' && c.status !== 'held') continue;
    c.status = 'cancelled';
    if (b && a.primaryId !== b.primaryId) {
      const shared = Math.max(0, Math.min(a.units, b.units, c.capacity.offset + c.capacity.units) - c.capacity.offset);
      if (shared) {
        const exemptions: [number, number][] = permanent.flatMap(i => i.capacity.filter(p => p.date === c.capacity.date)
          .map(p => [p.offset, p.offset + p.units] as [number, number]));
        const chargeable = gaps(c.capacity.offset, c.capacity.offset + shared, exemptions);
        for (const [lo, hi] of chargeable) exclude({date: c.capacity.date, offset: lo, units: hi - lo});
        const amount = chargeable.reduce((sum, [lo, hi]) => sum + hi - lo, 0);
        if (amount && c.claim.creditorId !== b.primaryId) effects.push({debtorId: c.claim.creditorId, creditorId: b.primaryId, units: amount});
      }
    }
  }
  const appliedIntents: {id: string; fromId: string; toId: string; units: number}[] = [];
  const intentIds = new Set<string>();
  const routeBudgets = new Map<string, {transfer: unknown; used: number}>();
  for (const intent of [...(after?.intents ?? [])].sort((a, b) => compareId(a.id, b.id))) {
    if (!intent.id || intentIds.has(intent.id) || !['temporary', 'permanent'].includes(intent.kind)) fail('invalid-intent');
    intentIds.add(intent.id);
    const prior = s.intents.get(intent.id);
    if (prior) {if (fingerprint(prior) !== fingerprint(intent)) fail('intent-lineage-changed'); continue;}
    endpoints(s, intent.fromId, intent.toId);
    const route = intent.route;
    if (route) {
      if (!route.length || route[0].fromId !== intent.fromId || route.at(-1)!.toId !== intent.toId ||
        route[0].kind !== intent.kind) fail('invalid-intent-route');
      for (const [i, leg] of route.entries()) {
        endpoints(s, leg.fromId, leg.toId);
        if (!['temporary', 'permanent'].includes(leg.kind) || (i && route[i - 1].toId !== leg.fromId) ||
          !leg.transferIds.length || leg.transferIds.some(id => typeof id !== 'string' || !id.trim())) fail('invalid-intent-route');
        if (Object.hasOwn(leg, 'deferredClaim')) {
          const c = leg.deferredClaim;
          if (!c || typeof c.debtorId !== 'string' || typeof c.creditorId !== 'string') fail('invalid-intent-route');
          segment(c, {at: 0, sequence: 0, lotId: 'reference'});
          if (!locate(s, c)) fail('invalid-deferred-source');
        }
        const trail = leg.counterparts;
        if (trail.length !== leg.transferIds.length || trail[0]?.fromId !== (leg.deferredClaim?.debtorId ?? leg.fromId) ||
          trail.at(-1)?.toId !== leg.toId || (leg.deferredClaim && leg.deferredClaim.creditorId !== leg.fromId) ||
          trail.some((t, j) => t.id !== leg.transferIds[j] || t.kind !== leg.kind ||
            (j > 0 && trail[j - 1].toId !== t.fromId))) fail('invalid-intent-route');
        for (const t of trail) {endpoints(s, t.fromId, t.toId); units(t.units, true);}
      }
    }
    if (!intent.capacity.length) fail('unfunded-intent');
    let amount = 0;
    for (const slice of intent.capacity) {
      capacity(next.get(slice.date), slice);
      if (next.get(slice.date)!.primaryId !== intent.toId) fail('intent-primary-mismatch');
      const previous = old.get(slice.date);
      if (previous && previous.primaryId !== intent.toId && previous.primaryId !== intent.fromId) fail('intent-counterpart-mismatch');
      if (previous?.primaryId === intent.toId && slice.offset < Math.min(previous.units, next.get(slice.date)!.units)) fail('unchanged-capacity-intent');
      exclude(slice); amount += slice.units; units(amount, true);
    }
    s.intents.set(intent.id, structuredClone(intent));
    if (route) {
      if (route.some(leg => leg.counterparts.some(t => t.units < amount))) fail('unfunded-intent-route');
      for (const [i, leg] of route.entries()) {
        for (const t of leg.counterparts) {
          const budget = routeBudgets.get(t.id);
          if (budget && fingerprint(budget.transfer) !== fingerprint(t)) fail('intent-counterpart-lineage-changed');
          const used = (budget?.used ?? 0) + amount;
          if (used > t.units) fail('unfunded-intent-route');
          routeBudgets.set(t.id, {transfer: t, used});
        }
        if (leg.kind === 'temporary') appliedIntents.push({
          id: `${intent.id}/route/${i}`, fromId: leg.fromId, toId: leg.toId, units: amount});
      }
    } else if (intent.kind === 'temporary') appliedIntents.push({id: intent.id, fromId: intent.fromId, toId: intent.toId, units: amount});
  }
  for (const [date, a] of old) {
    if (a.endInstantMs <= event.at) continue;
    const b = next.get(date);
    if (!b || a.primaryId === b.primaryId) continue;
    const shared = Math.min(a.units, b.units);
    const classified = (excluded.get(date) ?? []).reduce((sum, [lo, hi]) => sum + Math.max(0, Math.min(shared, hi) - lo), 0);
    if (shared > classified) {
      effects.push({debtorId: a.primaryId, creditorId: b.primaryId, units: shared - classified});
      // Ordinary transferred capacity cannot simultaneously fund a repayment.
      for (const [lo, hi] of gaps(0, shared, excluded.get(date) ?? [])) exclude({date, offset: lo, units: hi - lo});
    }
  }
  // Net an entire swap/transition once, before turning its residual transfers into source lots.
  const temporary = effects.map((e, i) => segment({...e, path: [{lotId: String(i), offset: 0, units: e.units}]},
    {at: event.at, sequence: event.sequence, lotId: String(i)}));
  const netted = normalize(temporary, new Set([...s.members.values()].filter(m => m.active).map(m => m.id))).claims;
  for (const [i, c] of netted.entries()) addLot(s, event, `${event.sourceKey}/transfer/${i}`, c.debtorId, c.creditorId, c.units);
  for (const intent of appliedIntents) addLot(s, event, `${event.sourceKey}/intent/${intent.id}`, intent.fromId, intent.toId, intent.units);
  // Reservations must reference the post-transition normalized graph.
  if (after) s.publications.set(op.month, structuredClone(after)); else s.publications.delete(op.month);
  return () => {
    for (const r of proposed.values()) {
      const existing = s.contributions.get(r.id), atom = next.get(r.capacity.date)!;
      if (existing) {
        const historicalTerminal = op.mode === 'delete' && ['cancelled', 'settled'].includes(existing.status);
        if ((!before?.reservations.some(old => old.id === r.id) && !historicalTerminal) || !sameReservation(reservationData(existing), r)) fail('reused-contribution');
      } else {
        if (atom.endInstantMs <= event.at) fail('reservation-already-completed');
        exclude(r.capacity);
        reserve(s, {...structuredClone(r), endInstantMs: atom.endInstantMs, status: 'pending'});
      }
    }
    // Carried reservations also consume capacity alongside any newly reviewed intents.
    for (const r of proposed.values()) if (before?.reservations.some(old => old.id === r.id) &&
      ['pending', 'held'].includes(s.contributions.get(r.id)!.status)) exclude(r.capacity);
  };
}
