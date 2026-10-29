import {sliceClaim} from '../compensation/index.ts';
import {ceilings, context, grain, type Context} from './model.ts';
import type {AllocationInput, AllocationDraft, Transfer} from './types.ts';

/** Synchronous proposal: plain arithmetic, no solver. Date placement and the
 * exact coverage check remain Generate's job.
 * 1. Equal ordinary shares; remainders go to the newest members.
 * 2. Open obligations are repaid oldest first, capped by the debtor's
 *    availability ceiling and by the creditor's locked floor.
 * 3. Locks are floors: a member below them takes temporary work from the member
 *    with most points (most senior on ties). */
export function proposeAllocation(input: AllocationInput) {
  const c = context(input), g = grain(c), ceiling = ceilings(c), n = c.ids.length;
  const share = Math.floor(c.total / (n * g)) * g;
  const baseline = Object.fromEntries(c.ids.map(id => [id, share]));
  let left = c.total - share * n;
  for (const id of [...input.seniority].reverse()) {if (!left) break; const add = Math.min(g, left); baseline[id] += add; left -= add;}
  const targets = {...baseline}, repayments: AllocationDraft['repayments'] = [];
  for (const claim of c.candidates) {
    const room = Math.min(claim.units, ceiling[claim.debtorId] - targets[claim.debtorId], targets[claim.creditorId] - c.locked[claim.creditorId]);
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
    repayments, transfers, pending: [], sourceKey: c.key};
  return {draft, projection: c.projection};
}

/** Givers: most points first, most senior on ties. */
export function givers(c: Context, seniority: readonly string[], targets: Record<string, number>) {
  return [...c.ids].sort((a, b) => targets[b] - targets[a] || seniority.indexOf(a) - seniority.indexOf(b));
}

/** Per-member availability ceilings in units, for the live inline check. */
export function allocationCeilings(input: AllocationInput) {
  return ceilings(context(input));
}

export function assertCurrent(c: Context, draft: AllocationDraft) {
  if (draft.sourceKey !== c.key) throw Error('stale-allocation');
}
