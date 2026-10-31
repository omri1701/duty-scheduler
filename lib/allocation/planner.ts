import {sliceClaim} from '../compensation/index.ts';
import {canonicalDuties} from '../scheduling/calendar.ts';
import {balanceChanges, deriveTransfers, handOf, type Hand} from './derive.ts';
import {equalShares, fitPartition} from './fit.ts';
import {ceilings, context, grain, type Context} from './model.ts';
import type {AllocationInput, AllocationDraft, Change, Pair, UnevenTransfer} from './types.ts';

/** Per-person changes worth keeping across proposals: the hand changes, pairs and
 * the confirmed ordinary baseline (immutable while duties and participants stand). */
export type Retained = {hand: Hand; pairs: Pair[]; baselineUnits?: Record<string, number>};

/** Synchronous proposal: plain arithmetic, no solver. Date placement and the
 * exact coverage check remain Generate's job.
 * One extra each, before anyone gets two (decision 2026-11-01):
 * 1. Open obligations are repaid newest member first, per creditor (creditors in
 *    the order of their oldest debt), each debtor from its own oldest debt, at
 *    most one point per debtor per month over all creditors, capped by the
 *    debtor's availability ceiling and by the creditor's relief (above its locks;
 *    work carried as uneven credit is never relief). The rest carries over.
 * 2. Equal ordinary shares; the larger shares (remainders) go to the newest
 *    members who are not repaying this month, then, only if needed, to the newest
 *    repayers. When the indivisible duties cannot split equally, the cheapest
 *    exact partition is used the same way, and the extra above the plain split is
 *    temporary credit (`uneven`).
 * 3. Locks are floors: a member below them takes temporary work from the member
 *    with most points (most senior on ties), as part of the automatic balance.
 * `retained` hand changes and pairs of members still present are reapplied
 * when they fit the new proposal; otherwise the plain proposal stands. A
 * retained baseline that is the same partition keeps its arrangement, so a
 * seniority reorder never forces a different ordinary baseline. */
export function proposeAllocation(input: AllocationInput, retained?: Retained) {
  const c = context(input), g = grain(c), ceiling = ceilings(c), weights = c.prepared.duties.map(d => d.units);
  const shares = fitPartition(weights, c.ids.length);
  const newest = [...input.seniority].reverse();
  // Larger shares newest first, members repaying this month last.
  const arrange = (repaying: ReadonlySet<string>) => {
    const order = [...newest.filter(id => !repaying.has(id)), ...newest.filter(id => repaying.has(id))];
    const descending = [...shares].sort((a, b) => b - a);
    const share = new Map(order.map((id, k) => [id, descending[k]]));
    return Object.fromEntries(c.ids.map(id => [id, share.get(id)!]));
  };
  const kept = retained?.baselineUnits;
  const keep = !!kept && Object.keys(kept).length === c.ids.length && c.ids.every(id => Number.isSafeInteger(kept[id])) &&
    JSON.stringify(c.ids.map(id => kept[id]).sort((a, b) => a - b)) === JSON.stringify([...shares].sort((a, b) => a - b));
  const repay = (baseline: Record<string, number>) => {
    const carried = carriedUnits(unevenTransfers(input.seniority, weights, baseline));
    const offered = {...baseline}, repayments: AllocationDraft['repayments'] = [], extra: Record<string, number> = {};
    const creditors = [...new Set(c.candidates.map(k => k.creditorId))];
    for (const creditorId of creditors) for (const debtorId of newest) {
      // Each debtor repays from its own oldest debt to this creditor, at most one point a month in all.
      for (const claim of c.candidates.filter(k => k.creditorId === creditorId && k.debtorId === debtorId)) {
        const room = Math.min(claim.units, 2 - (extra[debtorId] ?? 0), ceiling[debtorId] - offered[debtorId],
          offered[creditorId] - c.locked[creditorId] - (carried[creditorId] ?? 0));
        const amount = Math.floor(Math.max(0, room) / g) * g;
        if (!amount) continue;
        repayments.push({claim: {...claim, ...sliceClaim(claim, amount), units: amount}, units: amount});
        offered[debtorId] += amount; offered[creditorId] -= amount; extra[debtorId] = (extra[debtorId] ?? 0) + amount;
      }
    }
    return {offered, repayments, repaying: new Set(Object.keys(extra))};
  };
  // Who repays depends on the creditors' shares and the shares on who repays: settle both.
  let baseline = keep ? Object.fromEntries(c.ids.map(id => [id, kept![id]])) : arrange(new Set()), plan = repay(baseline);
  for (let round = 0; !keep && round < c.ids.length; round++) {
    const next = arrange(plan.repaying);
    if (c.ids.every(id => next[id] === baseline[id])) break;
    baseline = next; plan = repay(baseline);
  }
  const {offered, repayments} = plan;
  const build = (hand: Hand, pairs: Pair[]): AllocationDraft => {
    const {changes} = balanceChanges(c, input.seniority, baseline, offered, hand);
    const targets = Object.fromEntries(c.ids.map(id => [id, offered[id] + changes[id].temporary + changes[id].permanent]));
    return {baselineUnits: baseline, offeredUnits: offered, targetsUnits: targets, repayments, changes, pairs,
      transfers: deriveTransfers(input.seniority, changes, pairs), uneven: unevenTransfers(input.seniority, weights, baseline, changes),
      sourceKey: c.key, ...(Object.keys(hand).length ? {hand: Object.keys(hand)} : {})};
  };
  let draft = build({}, []);
  if (retained) {
    const hand = Object.fromEntries(Object.entries(retained.hand).filter(([id]) => c.ids.includes(id)));
    const pairs = retained.pairs.filter(p => c.ids.includes(p.fromId) && c.ids.includes(p.toId));
    const fits = Object.entries(hand).every(([id, ch]) => ch.permanent >= -Math.min(baseline[id], offered[id]) &&
      baseline[id] + ch.permanent <= c.total && offered[id] + ch.temporary + ch.permanent >= c.locked[id]);
    if (fits && Object.keys(hand).length) draft = build(hand, pairs);
  }
  return {draft, projection: c.projection};
}

/** The per-person changes and ordinary baseline of a draft, for a later proposal. */
export function retainedChanges(draft: AllocationDraft | null): Retained | undefined {
  if (!draft?.changes || !Array.isArray(draft.pairs)) return undefined;
  return {hand: handOf(draft), pairs: structuredClone(draft.pairs),
    ...(draft.baselineUnits && typeof draft.baselineUnits === 'object' ? {baselineUnits: {...draft.baselineUnits}} : {})};
}

/** System credit for an indivisible month (decision 2026-10-30): the fitted
 * baseline's excess over the plain equal split, owed as temporary transfers.
 * The baseline is compared rank by rank with the sorted plain split, so the
 * remainder choice itself never creates debt; only the fit's deviation does.
 * Among equal points the newest member takes the kinder plain share, so the
 * more senior one carries the difference. A creditor is credited only for the
 * extra it still carries after its net permanent loss, and a debtor owes only
 * while it still sits below the split after its net permanent gain (decision
 * 2026-10-31). Debtors: fewest points, most senior first. Creditors: most
 * points, most senior first. duty_private.allocation_uneven is the same
 * derivation; the checked RPC refuses any other list. */
export function unevenTransfers(seniority: readonly string[], weights: readonly number[], baseline: Readonly<Record<string, number>>,
  changes: Readonly<Record<string, Change | undefined>> = {}): UnevenTransfer[] {
  const n = seniority.length, plain = equalShares(weights, n);
  const rank = (id: string) => seniority.indexOf(id), points = (id: string) => baseline[id] ?? 0;
  const permanent = (id: string) => changes[id]?.permanent ?? 0;
  const excess = new Map<string, number>(), deficit = new Map<string, number>();
  [...seniority].sort((a, b) => points(b) - points(a) || rank(b) - rank(a)).forEach((id, k) => {
    const d = points(id) - plain[n - 1 - k] - Math.max(0, -permanent(id)); if (d > 0) excess.set(id, d);
  });
  [...seniority].sort((a, b) => points(a) - points(b) || rank(b) - rank(a)).forEach((id, k) => {
    const d = plain[k] - points(id) - Math.max(0, permanent(id)); if (d > 0) deficit.set(id, d);
  });
  const creditors = [...excess.keys()].sort((a, b) => points(b) - points(a) || rank(a) - rank(b));
  const debtors = [...deficit.keys()].sort((a, b) => points(a) - points(b) || rank(a) - rank(b));
  const result: UnevenTransfer[] = [];
  for (const creditorId of creditors) for (const debtorId of debtors) {
    const units = Math.min(excess.get(creditorId)!, deficit.get(debtorId)!);
    if (!units) continue;
    result.push({id: `uneven/${debtorId}/${creditorId}`, fromId: debtorId, toId: creditorId, units});
    excess.set(creditorId, excess.get(creditorId)! - units); deficit.set(debtorId, deficit.get(debtorId)! - units);
  }
  return result;
}

/** Units each creditor carries as uneven credit. */
export function carriedUnits(uneven: readonly UnevenTransfer[]) {
  const carried: Record<string, number> = {};
  for (const u of uneven) carried[u.toId] = (carried[u.toId] ?? 0) + u.units;
  return carried;
}

/** Members whose ordinary share is above the plain equal split, because the
 * month's duties are indivisible. Empty when the equal split stands, whichever
 * member holds a remainder. */
export function unevenBaseline(input: AllocationInput, baseline: Record<string, number>) {
  const weights = canonicalDuties(input.schedule.month, input.schedule.calendar).map(d => d.units);
  const credited = new Set(unevenTransfers(input.seniority, weights, baseline).map(u => u.toId));
  return input.seniority.flatMap(id => credited.has(id) ? [{id, units: baseline[id]}] : []);
}

/** Per-member availability ceilings in units, for the live inline check. */
export function allocationCeilings(input: AllocationInput) {
  return ceilings(context(input));
}

export function assertCurrent(c: Context, draft: AllocationDraft) {
  if (draft.sourceKey !== c.key) throw Error('stale-allocation');
}
