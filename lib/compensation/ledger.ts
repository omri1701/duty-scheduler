import {compareId, comparePriority, sliceClaim, units} from './normalize.ts';
import {transition} from './publication.ts';
import {addLot, available, consume, emptyState, fail, fingerprint, instant, locate, normalizeState, settle, view, type State} from './state.ts';
import type {Command, CompensationEvent, Contribution, Operation} from './types.ts';

export const CORE_VERSION = 'compensation-v1';
function due(s: State, now: number) {
  return [...s.contributions.values()].filter(c => c.status === 'pending' && c.endInstantMs <= now)
    .sort((a, b) => a.endInstantMs - b.endInstantMs || compareId(a.id, b.id));
}
function eligibility(s: State, c: Contribution) {
  if (!s.members.get(c.claim.debtorId)?.active || !s.members.get(c.claim.creditorId)?.active) return 'inactive';
  if (!locate(s, c.claim)) return 'claim-changed';
  return null;
}
function apply(s: State, event: CompensationEvent, committed = true) {
  const op = event.operation;
  if (op.kind !== 'earned' && op.kind !== 'hold' && due(s, event.at).length) fail('reconciliation-required');
  if (['claim', 'adjust', 'correct', 'reverse-settlement', 'release'].includes(op.kind) && !event.reason?.trim()) fail('manual-reason-required');
  let finish: (() => void) | undefined;
  switch (op.kind) {
    case 'members': {
      const ids = new Set<string>();
      for (const m of op.members) {
        if (!m.id || typeof m.active !== 'boolean' || ids.has(m.id)) fail('invalid-member');
        ids.add(m.id); s.members.set(m.id, {...m});
      }
      break;
    }
    case 'claim': addLot(s, event, event.sourceKey, op.debtorId, op.creditorId, op.units); break;
    case 'adjust': {
      units(op.units, true);
      if (op.mode === 'settle') settle(s, event.sourceKey, op.claim, op.units);
      else if (op.mode === 'reduce') consume(s, op.claim, op.units);
      else fail('invalid-adjustment');
      break;
    }
    case 'correct': {
      if (!Number.isSafeInteger(op.deltaUnits) || !op.deltaUnits) fail('invalid-correction');
      const lot = s.lots.get(op.lotId);
      if (!lot) fail('unknown-correction-source');
      units(lot!.correctedUnits + op.deltaUnits);
      lot!.correctedUnits += op.deltaUnits;
      // A correction is a current-sequence compensating lot, never a historical replay insertion.
      addLot(s, event, event.sourceKey, op.deltaUnits > 0 ? lot!.debtorId : lot!.creditorId,
        op.deltaUnits > 0 ? lot!.creditorId : lot!.debtorId, Math.abs(op.deltaUnits), lot!.priority, lot!.id);
      break;
    }
    case 'reverse-settlement': {
      const previous = s.settlements.get(op.settlementId);
      if (!previous || previous.reversed) fail('invalid-settlement-reversal');
      previous.reversed = true;
      const priority = previous.claim.path.map(p => s.lots.get(p.lotId)!.priority).sort(comparePriority)[0];
      addLot(s, event, event.sourceKey, previous.claim.debtorId, previous.claim.creditorId, previous.units, priority, previous.id);
      // Completed capacity remains consumed. A reversal cannot make a duty earn again.
      break;
    }
    case 'release': {
      const c = s.contributions.get(op.contributionId);
      if (!c || (c.status !== 'pending' && c.status !== 'held')) fail('invalid-release');
      c.status = 'cancelled'; break;
    }
    case 'publication': finish = transition(s, event, op); break;
    case 'earned': {
      const c = s.contributions.get(op.contributionId);
      if (!c || c.status !== 'pending' || c.endInstantMs > event.at || eligibility(s, c)) fail('unearned-settlement');
      c.status = 'settled'; c.settlementId = event.sourceKey;
      settle(s, event.sourceKey, c.claim, c.capacity.units, c.id); break;
    }
    case 'hold': {
      const c = s.contributions.get(op.contributionId);
      if (!c || c.status !== 'pending' || c.endInstantMs > event.at || eligibility(s, c) !== op.reason) fail('invalid-hold');
      c.status = 'held'; c.holdReason = op.reason; break;
    }
    default: fail('unknown-operation');
  }
  normalizeState(s); finish?.();
  if (committed) s.events.push(structuredClone(event));
}
function build(events: readonly CompensationEvent[]) {
  const s = emptyState(), sources = new Map<string, string>();
  let sequence = 0, at = 0;
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    instant(event.at);
    if (!event.sourceKey?.trim() || !event.actor?.trim()) fail('invalid-event');
    const prior = sources.get(event.sourceKey), key = fingerprint(event);
    if (prior) {if (prior !== key) fail('source-key-conflict'); continue;}
    if (!Number.isSafeInteger(event.sequence) || event.sequence <= sequence || event.at < at) fail('invalid-event-order');
    if ((event.operation.kind === 'earned' || event.operation.kind === 'hold') &&
      event.sourceKey !== `@${event.operation.kind}/${event.operation.contributionId}`) fail('invalid-derived-source');
    apply(s, structuredClone(event)); sources.set(event.sourceKey, key); sequence = event.sequence; at = event.at;
  }
  return s;
}
export function replay(events: readonly CompensationEvent[]) {return view(build(events));}
function internal(s: State, now: number, c: Contribution): CompensationEvent {
  const reason = eligibility(s, c), kind = reason ? 'hold' : 'earned';
  return {sourceKey: `@${kind}/${c.id}`, sequence: (s.events.at(-1)?.sequence ?? 0) + 1,
    at: now, actor: 'system', operation: reason ? {kind: 'hold', contributionId: c.id, reason} : {kind: 'earned', contributionId: c.id}};
}
function reconcileState(s: State, now: number) {
  instant(now);
  if (now < (s.events.at(-1)?.at ?? 0)) fail('time-before-history');
  for (const c of due(s, now)) if (c.status === 'pending') apply(s, internal(s, now, c));
}
/** Returns the full immutable history; only its missing suffix needs persistence under the workspace lock. */
export function reconcile(events: readonly CompensationEvent[], now: number) {
  const s = build(events); reconcileState(s, now); return view(s);
}
export function record(events: readonly CompensationEvent[], command: Command) {
  if (command.sourceKey.startsWith('@')) fail('reserved-source-key');
  const s = build(events), prior = s.events.find(e => e.sourceKey === command.sourceKey);
  if (prior) {
    // A retry can sample a later server time, but cannot change the operation, actor or reason.
    const content = (c: Command | CompensationEvent) => ({sourceKey: c.sourceKey, actor: c.actor, reason: c.reason, operation: c.operation});
    if (fingerprint(content(prior)) !== fingerprint(content(command))) fail('source-key-conflict');
  }
  reconcileState(s, command.at);
  if (!prior) apply(s, {...structuredClone(command), sequence: (s.events.at(-1)?.sequence ?? 0) + 1});
  // Validate caller-supplied command envelopes just like persisted events.
  return replay(s.events);
}
export function repaymentCandidates(events: readonly CompensationEvent[]) {return structuredClone(available(build(events)));}
export function ledgerFingerprint(events: readonly CompensationEvent[]) {
  return fingerprint({version: CORE_VERSION, events: build(events).events});
}
export function project(events: readonly CompensationEvent[], now: number, cutoffMs: number) {
  instant(cutoffMs); if (cutoffMs < now) fail('projection-before-now');
  const s = build(events); reconcileState(s, now);
  const actual = view(s), sourceFingerprint = ledgerFingerprint(s.events);
  // Simulate on an isolated state; no projection event is returned as committed history.
  for (const c of due(s, cutoffMs)) if (c.status === 'pending') apply(s, internal(s, cutoffMs, c), false);
  const projected = view(s);
  return {actual, actualAtMs: now, cutoffMs, sourceFingerprint,
    projected: {claims: projected.claims, net: projected.net, candidates: structuredClone(available(s))}};
}
/** Build an explicit partial reference without rounding or changing its original priority. */
export {sliceClaim};
export type {Operation};
