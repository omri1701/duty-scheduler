import {CompensationError, type ClaimRef, type ClaimSegment, type NormalizationStep, type Priority} from './types.ts';

export const compareId = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export function units(value: number, positive = false) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0) || value > 1e9) throw new CompensationError('invalid-units');
  return value;
}
export function halfUnits(points: number) {return units(points * 2);}
/** The lone half of an amount: 1 unit when it cannot pair into whole points. A lone
 * half is never rounded, forgiven or expired; it waits for a second half or for a
 * month with half-point duties, and it chains across people like any other claim. */
export const loneHalf = (value: number) => Math.abs(value) % 2;
export const comparePriority = (a: Priority, b: Priority) => a.at - b.at || a.sequence - b.sequence || compareId(a.lotId, b.lotId);
export const claimId = (c: ClaimRef) => JSON.stringify([c.debtorId, c.creditorId, c.path.map(s => [s.lotId, s.offset, s.units])]);
export const compareClaims = (a: ClaimSegment, b: ClaimSegment) => comparePriority(a.priority, b.priority) || compareId(a.id, b.id);
export function segment(ref: ClaimRef, priority: Priority, frozen = false): ClaimSegment {
  if (!ref.path.length) throw new CompensationError('empty-path');
  const amount = units(ref.path[0].units, true);
  if (!ref.debtorId || !ref.creditorId || ref.debtorId === ref.creditorId ||
    ref.path.some(s => !s.lotId || units(s.offset) + units(s.units, true) > 1e9 || s.units !== amount) ||
    ref.path.some((a, i) => ref.path.slice(i + 1).some(b => a.lotId === b.lotId && a.offset < b.offset + b.units && b.offset < a.offset + a.units))) throw new CompensationError('invalid-path');
  if (!Number.isSafeInteger(priority.at) || priority.at < 0 || !Number.isSafeInteger(priority.sequence) || priority.sequence < 0 || !priority.lotId) throw new CompensationError('invalid-priority');
  const copy = {debtorId: ref.debtorId, creditorId: ref.creditorId,
    path: ref.path.map(s => ({lotId: s.lotId, offset: s.offset, units: s.units}))};
  return {...copy, id: claimId(copy), units: amount, priority: {...priority}, frozen};
}
export function sliceClaim(c: ClaimRef, amount: number, offset = 0): ClaimRef {
  units(amount, true); units(offset);
  segment(c, {at: 0, sequence: 0, lotId: 'reference'});
  if (!c.path.length || offset + amount > c.path[0].units) throw new CompensationError('claim-slice-out-of-range');
  return {debtorId: c.debtorId, creditorId: c.creditorId,
    path: c.path.map(s => ({lotId: s.lotId, offset: s.offset + offset, units: amount}))};
}

/** Input is the previous normalized graph plus new segments, not reconstructed raw history. */
export function normalize(input: readonly ClaimSegment[], active: ReadonlySet<string>) {
  const edges = input.map(c => segment(c, c.priority, !active.has(c.debtorId) || !active.has(c.creditorId)));
  const sources = new Map<string, {offset: number; units: number}[]>();
  for (const edge of edges) for (const slice of edge.path) {
    const previous = sources.get(slice.lotId) ?? [];
    if (previous.some(p => p.offset < slice.offset + slice.units && slice.offset < p.offset + p.units)) throw new CompensationError('overlapping-source-slices');
    previous.push(slice); sources.set(slice.lotId, previous);
  }
  const steps: NormalizationStep[] = [];
  const live = () => edges.filter(e => e.units && !e.frozen).sort(compareClaims);
  const take = (edge: ClaimSegment, amount: number) => {
    const part = sliceClaim(edge, amount);
    if (amount === edge.units) edge.units = 0;
    else Object.assign(edge, segment(sliceClaim(edge, edge.units - amount, amount), edge.priority));
    return part;
  };
  for (;;) {
    const all = live(), a = all.find(e => all.some(f => e.debtorId === f.creditorId && e.creditorId === f.debtorId));
    if (!a) break;
    const b = all.find(e => e.debtorId === a.creditorId && e.creditorId === a.debtorId)!;
    const amount = Math.min(a.units, b.units);
    steps.push({kind: 'opposing', units: amount, paths: [take(a, amount).path, take(b, amount).path]});
  }
  // Sorted DFS selects a reproducible directed cycle. Every cancellation removes an edge.
  for (;;) {
    const all = live(), vertices = [...new Set(all.flatMap(e => [e.debtorId, e.creditorId]))].sort(compareId);
    const visited = new Set<string>(), stack: string[] = [], path: ClaimSegment[] = [];
    let cycle: ClaimSegment[] | undefined;
    const visit = (v: string): boolean => {
      stack.push(v);
      for (const edge of all.filter(e => e.debtorId === v).sort((a, b) => compareId(a.creditorId, b.creditorId) || compareClaims(a, b))) {
        const index = stack.indexOf(edge.creditorId);
        if (index >= 0) {cycle = [...path.slice(index), edge]; return true;}
        if (!visited.has(edge.creditorId)) {path.push(edge); if (visit(edge.creditorId)) return true; path.pop();}
      }
      stack.pop(); visited.add(v); return false;
    };
    for (const v of vertices) if (!visited.has(v) && visit(v)) break;
    if (!cycle) break;
    const selected: ClaimSegment[] = cycle, amount = Math.min(...selected.map(e => e.units));
    steps.push({kind: 'cycle', units: amount, paths: selected.map(e => take(e, amount).path)});
  }
  // Kahn ordering is stable. Bypasses stay forward in this acyclic order.
  const all = live(), vertices = [...new Set(all.flatMap(e => [e.debtorId, e.creditorId]))].sort(compareId), order: string[] = [];
  while (order.length < vertices.length) {
    const v = vertices.find(v => !order.includes(v) && !all.some(e => e.creditorId === v && !order.includes(e.debtorId)));
    if (!v) throw new CompensationError('normalization-cycle');
    order.push(v);
  }
  for (const v of order) for (;;) {
    const incoming = live().find(e => e.creditorId === v), outgoing = live().find(e => e.debtorId === v);
    if (!incoming || !outgoing) break;
    const amount = Math.min(incoming.units, outgoing.units), a = take(incoming, amount), b = take(outgoing, amount);
    steps.push({kind: 'chain', units: amount, paths: [a.path, b.path]});
    edges.push(segment({debtorId: a.debtorId, creditorId: b.creditorId, path: [...a.path, ...b.path]},
      comparePriority(incoming.priority, outgoing.priority) <= 0 ? incoming.priority : outgoing.priority));
  }
  return {claims: edges.filter(e => e.units).sort(compareClaims), steps};
}
