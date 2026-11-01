import {compareId} from './normalize.ts';
import {fail} from './state.ts';
import {reconcile, record} from './ledger.ts';
import {handover} from '../scheduling/calendar.ts';
import type {CompensationEvent} from './types.ts';

/** The ledger a new plan for a published month starts from (decision 2026-11-01): every
 * lot the month's publications booked is reversed by an audited correction, then the
 * publication is deleted, which cancels its pending repayments. Nothing is rewritten.
 * Refused when a repayment of another month already uses one of those lots
 * (`review-replan-later:<month>`, the earliest), when part of one was settled by hand
 * (`review-replan-settled`), or once the month has started (`review-replan-started`).
 * duty_private.compensation_replan builds the same events. */
export function replanEvents(events: readonly CompensationEvent[], month: string, at: number, actor = 'system'): readonly CompensationEvent[] {
  const s = reconcile(events, at), pub = s.publications.find(p => p.month === month);
  if (!pub) return s.events;
  if (pub.duties.some(d => handover(d.endDate) * 60000 <= at)) fail('review-replan-started');
  const keys = new Set(s.events.filter(e => e.operation.kind === 'publication' && e.operation.month === month).map(e => e.sourceKey));
  const lots = s.lots.filter(l => keys.has(l.sourceKey)).sort((a, b) => compareId(a.id, b.id)), ids = new Set(lots.map(l => l.id));
  let other: string | undefined;
  for (const c of s.contributions) {
    if (c.status === 'cancelled' || !c.claim.path.some(p => ids.has(p.lotId))) continue;
    if (pub.reservations.some(r => r.id === c.id)) {if (c.status === 'settled') fail('review-replan-started'); continue;}
    const later = s.publications.filter(p => p.reservations.some(r => r.id === c.id)).map(p => p.month).sort(compareId)[0] ?? 'unknown';
    if (other === undefined || compareId(later, other) < 0) other = later;
  }
  if (other !== undefined) fail(`review-replan-later:${other}`);
  let next = s.events;
  for (const lot of lots) {
    if (lot.remaining < lot.units) fail('review-replan-settled');
    if (!lot.correctedUnits) continue;
    next = record(next, {sourceKey: `replan/${pub.id}/${lot.id}`, at, actor, reason: `Re-planned ${month}`,
      operation: {kind: 'correct', lotId: lot.id, deltaUnits: -lot.correctedUnits}}).events;
  }
  return record(next, {sourceKey: `replan/${pub.id}/delete`, at, actor,
    operation: {kind: 'publication', month, beforeId: pub.id, after: null, mode: 'delete'}}).events;
}
