import {compareId} from './normalize.ts';
import {fail} from './state.ts';
import {reconcile, record, replay} from './ledger.ts';
import {handover} from '../scheduling/calendar.ts';
import type {CompensationEvent} from './types.ts';

/** The ledger a new plan for a month starts from (decision 2026-11-01): every live lot the
 * month's publication events booked is reversed by an audited correction, then a current
 * publication is deleted, which cancels its pending repayments. Nothing is rewritten. A
 * month whose only version was deleted still has live lots: a new plan reverses them too,
 * so they are never counted twice. Keys carry the ledger position, so the month can be
 * re-planned again later. Refused when a repayment of another month already uses one of
 * those lots (`review-replan-later:<month>`, the earliest), when part of one was settled by
 * hand (`review-replan-settled`), or once the published month has started
 * (`review-replan-started`). duty_private.compensation_replan builds the same events. */
export function replanEvents(events: readonly CompensationEvent[], month: string, at: number, actor = 'system'): readonly CompensationEvent[] {
  const s = reconcile(events, at), pub = s.publications.find(p => p.month === month);
  const prefix = `replan/${pub?.id ?? 'none'}/${s.events.at(-1)?.sequence ?? 0}/`;
  if (pub?.duties.some(d => handover(d.endDate) * 60000 <= at)) fail('review-replan-started');
  const keys = new Set(s.events.filter(e => e.operation.kind === 'publication' && e.operation.month === month).map(e => e.sourceKey));
  const lots = s.lots.filter(l => keys.has(l.sourceKey) && l.correctedUnits > 0).sort((a, b) => compareId(a.id, b.id)), ids = new Set(lots.map(l => l.id));
  let other: string | undefined;
  for (const c of s.contributions) {
    if (c.status === 'cancelled' || !c.claim.path.some(p => ids.has(p.lotId))) continue;
    if (pub?.reservations.some(r => r.id === c.id)) {if (c.status === 'settled') fail('review-replan-started'); continue;}
    const later = s.publications.filter(p => p.reservations.some(r => r.id === c.id)).map(p => p.month).sort(compareId)[0] ?? 'unknown';
    if (other === undefined || compareId(later, other) < 0) other = later;
  }
  if (other !== undefined) fail(`review-replan-later:${other}`);
  let next = s.events;
  for (const lot of lots) {
    if (lot.remaining < lot.units) fail('review-replan-settled');
    next = record(next, {sourceKey: prefix + lot.id, at, actor, reason: `Re-planned ${month}`,
      operation: {kind: 'correct', lotId: lot.id, deltaUnits: -lot.correctedUnits}}).events;
  }
  if (pub) next = record(next, {sourceKey: prefix + 'delete', at, actor,
    operation: {kind: 'publication', month, beforeId: pub.id, after: null, mode: 'delete'}}).events;
  // Reversing the lots changes how debts net: another month's pending repayment on a debt
  // that changed would be held and never settle. That month is changed first.
  const held = replay(next).contributions.filter(c => c.status === 'held' && c.holdReason === 'claim-changed' &&
    s.contributions.some(o => o.id === c.id && o.status === 'pending'));
  const months = held.map(c => s.publications.filter(p => p.month !== month && p.reservations.some(r => r.id === c.id)).map(p => p.month).sort(compareId)[0] ?? 'unknown');
  if (months.length) fail(`review-replan-later:${months.sort(compareId)[0]}`);
  return next;
}
