import {compareClaims, normalize, segment, sliceClaim, units} from './normalize.ts';
import {CompensationError, type ClaimRef, type ClaimSegment, type CompensationEvent, type Contribution,
  type LedgerView, type Member, type NormalizationStep, type Priority, type Publication, type Settlement,
  type SourceLot, type SourceSlice, type TransferIntent} from './types.ts';

export function fail(code: string): never {throw new CompensationError(code);}
export function instant(value: number) {if (!Number.isSafeInteger(value) || value < 0) fail('invalid-instant'); return value;}
/** Object keys are canonical; array order (events, provenance paths) is significant. */
export function fingerprint(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(fingerprint).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => JSON.stringify(k) + ':' + fingerprint(v)).join(',') + '}';
  return JSON.stringify(value);
}
export type State = {
  events: CompensationEvent[]; members: Map<string, Member>; lots: Map<string, SourceLot>;
  claims: ClaimSegment[]; contributions: Map<string, Contribution>; settlements: Map<string, Settlement>;
  publications: Map<string, Publication>; intents: Map<string, TransferIntent>; normalizations: NormalizationStep[];
};
export const emptyState = (): State => ({events: [], members: new Map(), lots: new Map(), claims: [],
  contributions: new Map(), settlements: new Map(), publications: new Map(), intents: new Map(), normalizations: []});
export function endpoints(s: State, debtorId: string, creditorId: string) {
  if (!s.members.has(debtorId) || !s.members.has(creditorId) || debtorId === creditorId) fail('invalid-endpoints');
}
export function addLot(s: State, event: CompensationEvent, id: string, debtorId: string, creditorId: string,
  amount: number, originalPriority?: Priority, correctionOf?: string) {
  endpoints(s, debtorId, creditorId); units(amount, true);
  if (s.lots.has(id)) fail('duplicate-lot');
  const priority = originalPriority ?? {at: event.at, sequence: event.sequence, lotId: id};
  s.lots.set(id, {id, debtorId, creditorId, units: amount, remaining: amount, correctedUnits: amount,
    priority, sourceKey: event.sourceKey, ...(correctionOf ? {correctionOf} : {})});
  s.claims.push(segment({debtorId, creditorId, path: [{lotId: id, offset: 0, units: amount}]}, priority));
}
export const overlaps = (a: SourceSlice, b: SourceSlice) => a.lotId === b.lotId && a.offset < b.offset + b.units && b.offset < a.offset + a.units;
export function locate(s: State, ref: ClaimRef) {
  const checked = segment(ref, {at: 0, sequence: 0, lotId: 'reference'});
  return s.claims.find(c => c.debtorId === checked.debtorId && c.creditorId === checked.creditorId &&
    c.path.length === checked.path.length && checked.path.every((p, i) => p.lotId === c.path[i].lotId &&
      p.offset >= c.path[i].offset && p.offset + p.units <= c.path[i].offset + c.units &&
      p.offset - c.path[i].offset === checked.path[0].offset - c.path[0].offset));
}
export const reserved = (s: State) => [...s.contributions.values()].filter(c => c.status === 'pending' || c.status === 'held');
export function normalizeState(s: State) {
  const result = normalize(s.claims, new Set([...s.members.values()].filter(m => m.active).map(m => m.id)));
  s.claims = result.claims; s.normalizations.push(...result.steps);
  for (const c of s.contributions.values()) if (c.status === 'pending' && !locate(s, c.claim)) {
    c.status = 'held'; c.holdReason = 'claim-changed';
  }
}
export function consume(s: State, ref: ClaimRef, amount: number) {
  const part = sliceClaim(ref, amount), current = locate(s, part);
  if (!current) fail('claim-no-longer-outstanding');
  const edge = current!, offset = part.path[0].offset - edge.path[0].offset;
  s.claims = s.claims.filter(c => c !== edge);
  if (offset) s.claims.push(segment(sliceClaim(edge, offset), edge.priority, edge.frozen));
  const tail = edge.units - offset - amount;
  if (tail) s.claims.push(segment(sliceClaim(edge, tail, offset + amount), edge.priority, edge.frozen));
  for (const p of part.path) {
    const lot = s.lots.get(p.lotId);
    if (!lot || lot.remaining < amount) fail('source-over-settlement');
    lot!.remaining -= amount;
  }
  return part;
}
export function settle(s: State, id: string, ref: ClaimRef, amount: number, contributionId?: string) {
  if (s.settlements.has(id)) fail('duplicate-settlement');
  const claim = consume(s, ref, amount);
  s.settlements.set(id, {id, claim, units: amount, reversed: false, ...(contributionId ? {contributionId} : {})});
}
export function reserve(s: State, c: Contribution) {
  if (!c.id || s.contributions.has(c.id)) fail('duplicate-contribution');
  const claim = locate(s, c.claim);
  if (!claim || claim.frozen || c.capacity.units !== c.claim.path[0].units) fail('invalid-reservation-claim');
  if (reserved(s).some(r => r.claim.path.some(a => c.claim.path.some(b => overlaps(a, b))))) fail('claim-already-reserved');
  s.contributions.set(c.id, structuredClone(c));
}
/** Oldest-first candidates only. Global weighted feasibility belongs to the allocation planner. */
export function available(s: State) {
  const results: ClaimSegment[] = [];
  for (const c of s.claims.filter(c => !c.frozen)) {
    let ranges: [number, number][] = [[0, c.units]];
    for (const r of reserved(s)) for (const a of c.path) for (const b of r.claim.path) if (overlaps(a, b)) {
      const lo = Math.max(0, b.offset - a.offset), hi = Math.min(c.units, b.offset + b.units - a.offset);
      ranges = ranges.flatMap(([x, y]) => hi <= x || lo >= y ? [[x, y]] :
        [...(x < lo ? [[x, lo] as [number, number]] : []), ...(hi < y ? [[hi, y] as [number, number]] : [])]);
    }
    for (const [a, b] of ranges) results.push(segment(sliceClaim(c, b - a, a), c.priority));
  }
  return results.sort(compareClaims);
}
export function view(s: State): LedgerView {
  const net: Record<string, number> = Object.fromEntries([...s.members.keys()].sort().map(id => [id, 0]));
  for (const c of s.claims) {net[c.debtorId] -= c.units; net[c.creditorId] += c.units;}
  if (Object.values(net).some(n => !Number.isSafeInteger(n)) || Object.values(net).reduce((a, b) => a + b, 0) !== 0) fail('unsafe-net');
  return structuredClone({events: s.events, members: [...s.members.values()], lots: [...s.lots.values()], claims: s.claims,
    contributions: [...s.contributions.values()], settlements: [...s.settlements.values()], normalizations: s.normalizations,
    publications: [...s.publications.values()], net});
}
