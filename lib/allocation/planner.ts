import {sliceClaim} from '../compensation/index.ts';
import {canonicalDuties} from '../scheduling/calendar.ts';
import {balanceChanges, deriveTransfers, handOf, type Hand} from './derive.ts';
import {equalShares, fitPartition} from './fit.ts';
import {ceilings, context, grain, type Context} from './model.ts';
import type {AllocationInput, AllocationDraft, Pair} from './types.ts';

/** Per-person changes worth keeping across proposals: the hand changes and pairs. */
export type Retained = {hand: Hand; pairs: Pair[]};

/** Synchronous proposal: plain arithmetic, no solver. Date placement and the
 * exact coverage check remain Generate's job.
 * 1. Equal ordinary shares; remainders go to the newest members. When the
 *    indivisible duties cannot split that way, the cheapest exact partition
 *    is used instead, larger shares again to the newest members.
 * 2. Open obligations are repaid oldest first, capped by the debtor's
 *    availability ceiling and by the creditor's locked floor.
 * 3. Locks are floors: a member below them takes temporary work from the member
 *    with most points (most senior on ties), as part of the automatic balance.
 * `retained` hand changes and pairs of members still present are reapplied
 * when they fit the new proposal; otherwise the plain proposal stands. */
export function proposeAllocation(input: AllocationInput, retained?: Retained) {
  const c = context(input), g = grain(c), ceiling = ceilings(c);
  const shares = fitPartition(c.prepared.duties.map(d => d.units), c.ids.length);
  const baseline = Object.fromEntries(c.ids.map(id => [id, shares[input.seniority.indexOf(id)]]));
  const offered = {...baseline}, repayments: AllocationDraft['repayments'] = [];
  for (const claim of c.candidates) {
    const room = Math.min(claim.units, ceiling[claim.debtorId] - offered[claim.debtorId], offered[claim.creditorId] - c.locked[claim.creditorId]);
    const amount = Math.floor(Math.max(0, room) / g) * g;
    if (!amount) continue;
    repayments.push({claim: {...claim, ...sliceClaim(claim, amount), units: amount}, units: amount});
    offered[claim.debtorId] += amount; offered[claim.creditorId] -= amount;
  }
  const build = (hand: Hand, pairs: Pair[]): AllocationDraft => {
    const {changes} = balanceChanges(c, input.seniority, offered, hand);
    const targets = Object.fromEntries(c.ids.map(id => [id, offered[id] + changes[id].temporary + changes[id].permanent]));
    return {baselineUnits: baseline, offeredUnits: offered, targetsUnits: targets, repayments, changes, pairs,
      transfers: deriveTransfers(input.seniority, changes, pairs), sourceKey: c.key, ...(Object.keys(hand).length ? {hand: Object.keys(hand)} : {})};
  };
  let draft = build({}, []);
  if (retained) {
    const hand = Object.fromEntries(Object.entries(retained.hand).filter(([id]) => c.ids.includes(id)));
    const pairs = retained.pairs.filter(p => c.ids.includes(p.fromId) && c.ids.includes(p.toId));
    const fits = Object.entries(hand).every(([id, ch]) => ch.permanent >= -Math.min(baseline[id], offered[id]) &&
      offered[id] + ch.temporary + ch.permanent >= c.locked[id]);
    if (fits && Object.keys(hand).length) draft = build(hand, pairs);
  }
  return {draft, projection: c.projection};
}

/** The per-person changes of a draft, for a later proposal. */
export function retainedChanges(draft: AllocationDraft | null): Retained | undefined {
  if (!draft?.changes || !Array.isArray(draft.pairs)) return undefined;
  return {hand: handOf(draft), pairs: structuredClone(draft.pairs)};
}

/** Members whose ordinary share is above the plain equal split, because the
 * month's duties are indivisible. Empty when the equal split stands. */
export function unevenBaseline(input: AllocationInput, baseline: Record<string, number>) {
  const plain = equalShares(canonicalDuties(input.schedule.month, input.schedule.calendar).map(d => d.units), input.seniority.length);
  return input.seniority.flatMap((id, i) => (baseline[id] ?? 0) > plain[i] ? [{id, units: baseline[id]}] : []);
}

/** Per-member availability ceilings in units, for the live inline check. */
export function allocationCeilings(input: AllocationInput) {
  return ceilings(context(input));
}

export function assertCurrent(c: Context, draft: AllocationDraft) {
  if (draft.sourceKey !== c.key) throw Error('stale-allocation');
}
