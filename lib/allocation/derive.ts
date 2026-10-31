import {grain, type Context} from './model.ts';
import type {Change, Kind, Pair, Transfer} from './types.ts';

/** Permanent transfers precede temporary ones, so a member's permanent share
 * moves before any temporary relief defers repayment work. */
export const KINDS: readonly Kind[] = ['permanent', 'temporary'];
export const zeroChange = (): Change => ({temporary: 0, permanent: 0});
export const isKind = (v: unknown): v is Kind => v === 'temporary' || v === 'permanent';

export type Flow = {debtorId: string; creditorId: string; units: number};
/** Pairs net debtors (negative) with net creditors (positive): largest first,
 * then the given order, each side advancing only when exhausted. */
export function settle(balance: Readonly<Record<string, number>>, order: readonly string[]): Flow[] {
  const rank = (id: string) => {const i = order.indexOf(id); return i < 0 ? order.length : i;};
  const side = (sign: number) => Object.keys(balance).filter(id => Math.sign(balance[id]) === sign)
    .map(id => ({id, units: Math.abs(balance[id])})).sort((a, b) => b.units - a.units || rank(a.id) - rank(b.id));
  const debtors = side(-1), creditors = side(1), flows: Flow[] = [];
  for (let d = 0, c = 0; d < debtors.length && c < creditors.length;) {
    const units = Math.min(debtors[d].units, creditors[c].units);
    flows.push({debtorId: debtors[d].id, creditorId: creditors[c].id, units});
    debtors[d].units -= units; creditors[c].units -= units;
    if (!debtors[d].units) d++;
    if (!creditors[c].units) c++;
  }
  return flows;
}

/** The canonical transfer list of a per-person state, kind by kind: explicit
 * pairs first, clipped to the net changes they can still route, then the
 * remainder netted. One transfer per direction; round trips cancel in the nets.
 * duty_private.allocation_transfers is the same derivation. */
export function deriveTransfers(order: readonly string[], changes: Readonly<Record<string, Change | undefined>>, pairs: readonly Pair[]): Transfer[] {
  const out: Transfer[] = [];
  for (const kind of KINDS) {
    const remaining: Record<string, number> = Object.fromEntries(order.map(id => [id, changes[id]?.[kind] ?? 0]));
    const flows = new Map<string, Transfer>();
    const add = (fromId: string, toId: string, units: number) => {
      const id = `${kind}/${fromId}/${toId}`, known = flows.get(id);
      if (known) known.units += units; else flows.set(id, {id, fromId, toId, units, kind});
    };
    for (const p of pairs) {
      if (p.kind !== kind || !Object.hasOwn(remaining, p.fromId) || !Object.hasOwn(remaining, p.toId) || p.fromId === p.toId) continue;
      const units = Math.min(p.units, Math.max(0, -remaining[p.fromId]), Math.max(0, remaining[p.toId]));
      if (!(units > 0)) continue;
      add(p.fromId, p.toId, units); remaining[p.fromId] += units; remaining[p.toId] -= units;
    }
    for (const f of settle(remaining, order)) add(f.debtorId, f.creditorId, f.units);
    out.push(...flows.values());
  }
  return out;
}

export type Hand = Readonly<Record<string, Change>>;
/** The automatic balance, recomputed from scratch so it is order independent:
 * untouched members below their locked points take temporary work from the
 * member with most points (senior first); then each kind's hand total, permanent
 * first, is placed on members WITHOUT hand changes in duty steps, refreshing the
 * ranking after each step (receivers: fewest points, newest first; givers: most
 * points, senior first), never crossing a lock. A member already balancing the
 * other kind is chosen last, so one hand change of each kind lands on two
 * different members. A permanent receiver's fair share plus its permanent
 * change stays within the month's total points. Whatever cannot be placed is returned as `unplaced` and
 * blocks confirmation. */
export function balanceChanges(c: Context, seniority: readonly string[], baseline: Readonly<Record<string, number>>,
  offered: Readonly<Record<string, number>>, hand: Hand) {
  const changes: Record<string, Change> = Object.fromEntries(c.ids.map(id => [id, hand[id] ? {...hand[id]} : zeroChange()]));
  const free = c.ids.filter(id => !hand[id]), g = grain(c), rank = (id: string) => seniority.indexOf(id);
  const full = (id: string) => offered[id] + changes[id].temporary + changes[id].permanent;
  const other = (id: string, kind: Kind) => changes[id][kind === 'temporary' ? 'permanent' : 'temporary'] ? 1 : 0;
  const givers = (kind: Kind, units: number, except?: string) => free.filter(id => id !== except && full(id) - units >= c.locked[id])
    .sort((a, b) => other(a, kind) - other(b, kind) || full(b) - full(a) || rank(a) - rank(b));
  // A permanent receiver's fair share plus punishment never exceeds the month's total points.
  const receivers = (kind: Kind, units: number) => free.filter(id => kind !== 'permanent' || baseline[id] + changes[id].permanent + units <= c.total).sort((a, b) => other(a, kind) - other(b, kind) || full(a) - full(b) || rank(b) - rank(a));
  for (const id of seniority) {
    if (hand[id]) continue;
    while (full(id) < c.locked[id]) {
      const units = Math.min(g, c.locked[id] - full(id)), giver = givers('temporary', units, id)[0];
      if (!giver) break;
      changes[giver].temporary -= units; changes[id].temporary += units;
    }
  }
  const unplaced = zeroChange();
  for (const kind of KINDS) {
    let remaining = 0 - c.ids.reduce((n, id) => n + (hand[id]?.[kind] ?? 0), 0);
    while (remaining) {
      const sign = Math.sign(remaining), units = Math.min(Math.abs(remaining), g);
      const chosen = sign > 0 ? receivers(kind, units)[0] : givers(kind, units)[0];
      if (!chosen) break;
      changes[chosen][kind] += sign * units; remaining -= sign * units;
    }
    unplaced[kind] = remaining;
  }
  return {changes, unplaced};
}

/** The hand edits of a plan saved before they were stored: starting from every
 * member with a change (and every dragged pair's members, which stay hand
 * edited), drop members newest first while the automatic balance of the rest
 * still reproduces the saved changes exactly. A reopened legacy plan then lets
 * its automatic points flow on as the session that made them did. */
export function inferHand(c: Context, seniority: readonly string[], draft: {baselineUnits: Record<string, number>;
  offeredUnits: Record<string, number>; changes: Record<string, Change>; pairs: readonly Pair[]}): string[] {
  const kept = new Set(draft.pairs.flatMap(p => [p.fromId, p.toId]));
  const reproduces = (ids: string[]) => {
    const {changes, unplaced} = balanceChanges(c, seniority, draft.baselineUnits, draft.offeredUnits, Object.fromEntries(ids.map(id => [id, {...draft.changes[id]}])));
    return !unplaced.temporary && !unplaced.permanent && c.ids.every(id => KINDS.every(k => changes[id][k] === draft.changes[id][k]));
  };
  let hand = seniority.filter(id => kept.has(id) || draft.changes[id]?.temporary || draft.changes[id]?.permanent);
  if (!reproduces(hand)) return hand;
  for (const id of [...seniority].reverse()) {
    if (!hand.includes(id) || kept.has(id)) continue;
    const fewer = hand.filter(h => h !== id);
    if (reproduces(fewer)) hand = fewer;
  }
  return hand;
}

/** The hand state of a draft: its listed hand members, or (for a reopened
 * draft without one) every member with a nonzero change. */
export function handOf(draft: {changes: Record<string, Change>; hand?: string[]}): Record<string, Change> {
  const ids = draft.hand ?? Object.keys(draft.changes).filter(id => draft.changes[id].temporary || draft.changes[id].permanent);
  return Object.fromEntries(ids.map(id => [id, {...(draft.changes[id] ?? zeroChange())}]));
}
