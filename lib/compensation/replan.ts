import {compareId} from './normalize.ts';
import {fail} from './state.ts';
import {reconcile, record, replay} from './ledger.ts';
import {handover} from '../scheduling/calendar.ts';
import type {CompensationEvent, LedgerView} from './types.ts';

/** A repayment left held because the debt it repays changed (claim-changed) never silently
 * counts for nothing (decision 2026-11-07): every pending repayment of `before` that `events`
 * left held is released, and the work it planned is booked once as an ordinary debt the other
 * way (the repaid creditor owes the debtor who does it), audited with `reason`. The reverse debt
 * belongs to the month that planned the repayment. duty_private.compensation_release_held is the
 * same. */
export function releaseHeld(before: Pick<LedgerView, 'contributions'>, events: readonly CompensationEvent[], prefix: string, at: number, actor: string, reason: string) {
  const held = replay(events).contributions.filter(c => c.status === 'held' && c.holdReason === 'claim-changed' &&
    before.contributions.some(o => o.id === c.id && o.status === 'pending')).sort((a, b) => compareId(a.id, b.id));
  let next = events;
  for (const c of held) {
    next = record(next, {sourceKey: `${prefix}release/${c.id}`, at, actor, reason, operation: {kind: 'release', contributionId: c.id}}).events;
    next = record(next, {sourceKey: `${prefix}reverse/${c.id}`, at, actor, reason,
      operation: {kind: 'claim', debtorId: c.claim.creditorId, creditorId: c.claim.debtorId, units: c.capacity.units}}).events;
  }
  return next;
}

/** The ledger a new plan for a month starts from (decision 2026-11-01): every live lot the
 * month's publications booked is reversed by an audited correction, then a current
 * publication is deleted, which cancels its pending repayments. Nothing is rewritten. A
 * month whose only version was deleted still has live lots: a new plan reverses them too,
 * so they are never counted twice. Keys carry the ledger position, so the month can be
 * re-planned again later. A deleted or re-planned month counts as nothing (decision
 * 2026-11-07): a later month's pending repayment of its lots is released, and the work it
 * planned becomes an ordinary debt the other way (the repaid creditor owes the debtor), booked
 * once with the same audited reason, and reversed in turn when the later month is deleted or
 * re-planned. A pending repayment the reversals leave held (the debt it repays netted away) is
 * converted the same way (`releaseHeld`). Refused when a settled repayment of another month used
 * one of those lots (`review-replan-later:<month>`, the earliest), when part of one was settled by
 * hand (`review-replan-settled`), or once the published month has started
 * (`review-replan-started`), its last version counting when the only one was deleted: worked
 * days keep their debts. duty_private.compensation_replan builds the same events. */
export function replanEvents(events: readonly CompensationEvent[], month: string, at: number, actor = 'system', reason = `Re-planned ${month}`): readonly CompensationEvent[] {
  const s = reconcile(events, at), pub = s.publications.find(p => p.month === month);
  const prefix = `replan/${pub?.id ?? 'none'}/${s.events.at(-1)?.sequence ?? 0}/`;
  const last = pub ?? s.events.flatMap(e => e.operation.kind === 'publication' && e.operation.month === month && e.operation.after ? [e.operation.after] : []).at(-1);
  if (last?.duties.some(d => handover(d.endDate) * 60000 <= at)) fail('review-replan-started');
  const keys = new Set(s.events.filter(e => e.operation.kind === 'publication' && e.operation.month === month).map(e => e.sourceKey));
  // A debt booked for the month's own released repayment is the month's too: deleting or
  // re-planning the month that planned that work reverses it.
  const owned = new Set(s.events.flatMap(e => e.operation.kind === 'publication' && e.operation.month === month && e.operation.after ? e.operation.after.reservations.map(r => r.id) : []));
  const reversal = (key: string) => /^(?:replan|publication)\/[^/]+\/\d+\/reverse\/(.+)$/.exec(key)?.[1];
  const lots = s.lots.filter(l => (keys.has(l.sourceKey) || owned.has(reversal(l.sourceKey) ?? '')) && l.correctedUnits > 0).sort((a, b) => compareId(a.id, b.id)), ids = new Set(lots.map(l => l.id));
  let other: string | undefined;
  const released: (typeof s.contributions)[number][] = [];
  for (const c of [...s.contributions].sort((a, b) => compareId(a.id, b.id))) {
    if (c.status === 'cancelled' || !c.claim.path.some(p => ids.has(p.lotId))) continue;
    if (pub?.reservations.some(r => r.id === c.id)) {if (c.status === 'settled') fail('review-replan-started'); continue;}
    if (c.status === 'pending') {released.push(c); continue;}
    // A held repayment never counts; it stays as it is.
    if (c.status === 'held') continue;
    const later = s.publications.filter(p => p.reservations.some(r => r.id === c.id)).map(p => p.month).sort(compareId)[0] ?? 'unknown';
    if (other === undefined || compareId(later, other) < 0) other = later;
  }
  if (other !== undefined) fail(`review-replan-later:${other}`);
  let next = s.events;
  for (const c of released) next = record(next, {sourceKey: `${prefix}release/${c.id}`, at, actor, reason,
    operation: {kind: 'release', contributionId: c.id}}).events;
  for (const lot of lots) {
    if (lot.remaining < lot.units) fail('review-replan-settled');
    next = record(next, {sourceKey: prefix + lot.id, at, actor, reason,
      operation: {kind: 'correct', lotId: lot.id, deltaUnits: -lot.correctedUnits}}).events;
  }
  // The released work stays planned: its creditor now owes the debtor who does it.
  for (const c of released) next = record(next, {sourceKey: `${prefix}reverse/${c.id}`, at, actor, reason,
    operation: {kind: 'claim', debtorId: c.claim.creditorId, creditorId: c.claim.debtorId, units: c.capacity.units}}).events;
  if (pub) next = record(next, {sourceKey: prefix + 'delete', at, actor,
    operation: {kind: 'publication', month, beforeId: pub.id, after: null, mode: 'delete'}}).events;
  // Reversing the lots changes how debts net: another month's pending repayment on a debt
  // that changed would be held and count for nothing. It becomes a debt the other way too.
  return releaseHeld(s, next, prefix, at, actor, reason);
}
