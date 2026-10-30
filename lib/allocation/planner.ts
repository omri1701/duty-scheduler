import {sliceClaim} from '../compensation/index.ts';
import {equalShares, fitPartition} from './fit.ts';
import {ceilings, context, grain, type Context} from './model.ts';
import type {AllocationInput, AllocationDraft, Transfer, UnevenTransfer} from './types.ts';

/** Synchronous proposal: plain arithmetic, no solver. Date placement and the
 * exact coverage check remain Generate's job.
 * 1. Equal ordinary shares; remainders go to the newest members. When the
 *    indivisible duties cannot split that way, the cheapest exact partition
 *    is used instead, larger shares again to the newest members, and the extra
 *    above the plain split is credited as system temporary transfers.
 * 2. Open obligations are repaid oldest first, capped by the debtor's
 *    availability ceiling and by the creditor's locked floor and uneven credit.
 * 3. Locks are floors: a member below them takes temporary work from the member
 *    with most points (most senior on ties). */
export function proposeAllocation(input: AllocationInput) {
  const c = context(input), g = grain(c), ceiling = ceilings(c), weights = c.prepared.duties.map(d => d.units);
  const shares = fitPartition(weights, c.ids.length);
  const baseline = Object.fromEntries(c.ids.map(id => [id, shares[input.seniority.indexOf(id)]]));
  const uneven = unevenTransfers(input.seniority, weights, baseline), carried: Record<string, number> = {};
  for (const u of uneven) carried[u.toId] = (carried[u.toId] ?? 0) + u.units;
  const targets = {...baseline}, repayments: AllocationDraft['repayments'] = [];
  for (const claim of c.candidates) {
    // A creditor keeps the work carried for an uneven month; relief never consumes it.
    const room = Math.min(claim.units, ceiling[claim.debtorId] - targets[claim.debtorId],
      targets[claim.creditorId] - c.locked[claim.creditorId] - (carried[claim.creditorId] ?? 0));
    const amount = Math.floor(Math.max(0, room) / g) * g;
    if (!amount) continue;
    repayments.push({claim: {...claim, ...sliceClaim(claim, amount), units: amount}, units: amount});
    targets[claim.debtorId] += amount; targets[claim.creditorId] -= amount;
  }
  const offered = {...targets}, transfers: Transfer[] = [];
  for (const id of c.ids) while (targets[id] < c.locked[id]) {
    const need = c.locked[id] - targets[id];
    const giver = givers(c, input.seniority, targets).find(other => other !== id && targets[other] - Math.min(g, need) >= c.locked[other]);
    if (!giver) break;
    const amount = Math.min(g, need, targets[giver] - c.locked[giver]);
    const previous = transfers.find(t => t.fromId === giver && t.toId === id);
    if (previous) previous.units += amount;
    else transfers.push({id: `proposal/${giver}/${id}`, fromId: giver, toId: id, units: amount, kind: 'temporary'});
    targets[giver] -= amount; targets[id] += amount;
  }
  const draft: AllocationDraft = {baselineUnits: baseline, offeredUnits: offered, targetsUnits: targets,
    repayments, transfers, pending: [], sourceKey: c.key, uneven};
  return {draft, projection: c.projection};
}

/** Givers: most points first, most senior on ties. */
export function givers(c: Context, seniority: readonly string[], targets: Record<string, number>) {
  return [...c.ids].sort((a, b) => targets[b] - targets[a] || seniority.indexOf(a) - seniority.indexOf(b));
}

/** The credit an indivisible month creates (decision 2026-10-30). The fitted
 * baseline is compared rank by rank with the sorted plain equal split, so the
 * remainder choice itself never creates debt: only the fit's deviation does.
 * Among equal points the newest member takes the kinder plain share, so the more
 * senior one carries the difference. Debtors: fewest points, most senior first.
 * Creditors: most points, most senior first. Deterministic and pure; the database
 * (`duty_private.allocation_uneven`) derives the same list and refuses any other. */
export function unevenTransfers(seniority: readonly string[], weights: readonly number[], baseline: Readonly<Record<string, number>>): UnevenTransfer[] {
  const n = seniority.length, plain = equalShares(weights, n);
  const rank = (id: string) => seniority.indexOf(id), points = (id: string) => baseline[id] ?? 0;
  const excess = new Map<string, number>(), deficit = new Map<string, number>();
  [...seniority].sort((a, b) => points(b) - points(a) || rank(b) - rank(a)).forEach((id, k) => {
    const d = points(id) - plain[n - 1 - k]; if (d > 0) excess.set(id, d);
  });
  [...seniority].sort((a, b) => points(a) - points(b) || rank(b) - rank(a)).forEach((id, k) => {
    const d = plain[k] - points(id); if (d > 0) deficit.set(id, d);
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

/** Members whose ordinary share is above the plain equal split, because the
 * month's duties are indivisible: the creditors of `unevenTransfers`, in
 * seniority order. Empty when the equal split stands. */
export function unevenBaseline(input: AllocationInput, baseline: Record<string, number>) {
  const c = context(input), credited = new Set(unevenTransfers(input.seniority, c.prepared.duties.map(d => d.units), baseline).map(u => u.toId));
  return input.seniority.flatMap(id => credited.has(id) ? [{id, units: baseline[id]}] : []);
}

/** Per-member availability ceilings in units, for the live inline check. */
export function allocationCeilings(input: AllocationInput) {
  return ceilings(context(input));
}

export function assertCurrent(c: Context, draft: AllocationDraft) {
  if (draft.sourceKey !== c.key) throw Error('stale-allocation');
}
