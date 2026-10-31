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
 * 1. Each creditor's relief (its share above its locks; work carried as uneven
 *    credit is never relief) is repaid by its debtors in turns: one point at a
 *    time to the debtor who has repaid least of its current debt to that creditor
 *    (published repayment work counts), newest first on ties, from its own oldest
 *    debt, within its availability ceiling. A second round starts only after every
 *    debtor of that creditor has had one, and the turns carry on next month; a
 *    single debtor repays as much as the relief allows. The rest carries over.
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
  // Progress on today's debt: repayment work already published (pending, held or done)
  // against the lots that still back a debtor's open debt to that creditor.
  const progress = (debtorId: string, creditorId: string) => {
    const open = new Set(c.candidates.filter(k => k.debtorId === debtorId && k.creditorId === creditorId).flatMap(k => k.path.map(p => p.lotId)));
    return c.projection.actual.contributions.filter(k => k.status !== 'cancelled' && k.claim.debtorId === debtorId &&
      k.claim.creditorId === creditorId && k.claim.path.some(p => open.has(p.lotId))).reduce((n, k) => n + k.capacity.units, 0);
  };
  const repay = (baseline: Record<string, number>) => {
    const carried = carriedUnits(unevenTransfers(input.seniority, weights, baseline));
    const offered = {...baseline}, taken = new Map<string, number>(), order: string[] = [], repaying = new Set<string>();
    for (const creditorId of [...new Set(c.candidates.map(k => k.creditorId))]) {
      const claims = (id: string) => c.candidates.filter(k => k.debtorId === id && k.creditorId === creditorId);
      const owed = (id: string) => claims(id).reduce((n, k) => n + k.units - (taken.get(k.id) ?? 0), 0);
      const debtors = newest.filter(id => claims(id).length), turns = new Map(debtors.map(id => [id, progress(id, creditorId)]));
      const stuck = new Set<string>();
      // Turns: one point at a time to the debtor who has repaid least of this debt so far, newest
      // first on ties, while the creditor keeps relief above its locks and the debtor still owes.
      for (;;) {
        const relief = offered[creditorId] - c.locked[creditorId] - (carried[creditorId] ?? 0);
        const next = debtors.filter(id => !stuck.has(id) && owed(id) > 0)
          .sort((a, b) => turns.get(a)! - turns.get(b)! || newest.indexOf(a) - newest.indexOf(b))[0];
        if (!next || relief < g) break;
        let amount = Math.floor(Math.min(2, owed(next), ceiling[next] - offered[next], relief) / g) * g;
        if (amount <= 0) {stuck.add(next); continue;}
        offered[next] += amount; offered[creditorId] -= amount; turns.set(next, turns.get(next)! + amount); repaying.add(next);
        for (const k of claims(next)) {
          const part = Math.min(amount, k.units - (taken.get(k.id) ?? 0)); if (!part) continue;
          if (!taken.has(k.id)) order.push(k.id);
          taken.set(k.id, (taken.get(k.id) ?? 0) + part); amount -= part;
        }
      }
    }
    const repayments: AllocationDraft['repayments'] = order.map(id => {
      const claim = c.candidates.find(k => k.id === id)!, units = taken.get(id)!;
      return {claim: {...claim, ...sliceClaim(claim, units), units}, units};
    });
    return {offered, repayments, repaying};
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
