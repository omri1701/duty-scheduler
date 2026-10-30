import {normalize, sliceClaim} from '../compensation/index.ts';
import {compareClaims, segment} from '../compensation/normalize.ts';
import type {ClaimRef, ClaimSegment} from '../compensation/types.ts';
import {validateGeneration, type PrimaryAssignments} from '../scheduling/validate.ts';
import {context, sum, validTargets} from './model.ts';
import {validateDraft} from './edits.ts';
import type {AllocationInput, AllocationDraft, CompiledPlan, Intent, Check} from './types.ts';

type Token = {carrier: string; origin: string; units: number; claim?: ClaimSegment;
  trail: string[]; prior: Intent[]};
const part = (token: Token, amount: number, offset = 0): Token => ({...structuredClone(token), units: amount,
  ...(token.claim ? {claim: {...token.claim, ...sliceClaim(token.claim, amount, offset), units: amount}} : {}),
  prior: token.prior.map(p => ({...structuredClone(p), units: amount,
    ...(p.deferredClaim ? {deferredClaim: sliceClaim(p.deferredClaim, amount, offset)} : {})})),
});
const ref = (c: ClaimRef): ClaimRef => ({debtorId: c.debtorId, creditorId: c.creditorId, path: structuredClone(c.path)});

/** Compile ONLY the supplied actual draft against Generate's actual assignments;
 * it cannot substitute a different schedule's capacity here. */
export function compileAllocation(input: AllocationInput, draft: AllocationDraft, assignments: PrimaryAssignments) {
  const c = context(input); validateDraft(c, draft);
  if (draft.pending.length || !validTargets(c, draft.targetsUnits)) return {check: null, plan: null,
    confirmable: false, diagnostics: [{code: 'finish-pending-allocation-edits', certainty: 'fact' as const}]};
  const actual = structuredClone(assignments);
  const metrics = validateGeneration({...input.schedule,
    targets: Object.fromEntries(c.ids.map(id => [id, draft.targetsUnits[id] / 2]))}, actual);
  const check: Check = {feasibility: metrics.deficits.every(n => n === 0) ? 'complete' : 'partial',
    assignments: actual, coverage: metrics.coverage, special: metrics.special, assignedUnits: metrics.units,
    actualUnits: Object.fromEntries(c.ids.map((id, i) => [id, draft.targetsUnits[id] - metrics.deficits[i]])),
    stages: [], diagnostics: []};
  for (const id of c.ids) if (check.actualUnits[id] < draft.targetsUnits[id]) check.diagnostics.push({
    code: 'unfunded-target', certainty: 'fact', engineer: id, units: draft.targetsUnits[id] - check.actualUnits[id]});
  for (const duty of c.prepared.duties) if (actual[duty.id].primary === null) check.diagnostics.push({
    code: 'uncovered-duty', certainty: 'fact', dutyId: duty.id, dates: duty.dates, units: duty.units});
  const tokens: Token[] = c.ids.map(id => ({carrier: id, origin: id, units: draft.baselineUnits[id], trail: [], prior: []}));
  for (const r of draft.repayments) {
    let remaining = r.units;
    for (const t of tokens.filter(t => t.carrier === r.claim.creditorId && !t.claim)) {
      const take = Math.min(t.units, remaining); t.units -= take; remaining -= take;
    }
    if (remaining) throw Error('repayment-exceeds-creditor-relief');
    tokens.push({carrier: r.claim.debtorId, origin: r.claim.creditorId, units: r.units, claim: structuredClone(r.claim), trail: [], prior: []});
  }
  for (const transfer of draft.transfers) {
    let remaining = transfer.units;
    // A lowered debtor limit defers newest repayment first, retaining oldest work.
    const available = tokens.filter(t => t.units && t.carrier === transfer.fromId).sort((a, b) => {
      if (!!a.claim !== !!b.claim) return a.claim ? -1 : 1;
      return a.claim && b.claim ? -compareClaims(a.claim, b.claim) : 0;
    });
    for (const t of available) {
      if (!remaining) break;
      const take = Math.min(t.units, remaining), moved = part(t, take, t.units - take);
      // Keep the oldest prefix on the original carrier.
      t.units -= take; if (t.claim && t.units) t.claim = {...t.claim, ...sliceClaim(t.claim, t.units), units: t.units};
      moved.carrier = transfer.toId;
      if (transfer.kind === 'permanent') {
        if (moved.trail.length && moved.origin !== transfer.fromId) moved.prior.push({fromId: moved.origin,
          toId: transfer.fromId, units: take, kind: 'temporary', transferIds: [...moved.trail],
          ...(moved.claim ? {deferredClaim: ref(moved.claim)} : {})});
        moved.prior.push({fromId: transfer.fromId, toId: transfer.toId, units: take, kind: 'permanent', transferIds: [transfer.id]});
        moved.origin = transfer.toId; moved.claim = undefined; moved.trail = [];
      } else moved.trail.push(transfer.id);
      tokens.push(moved); remaining -= take;
    }
    if (remaining) throw Error('transfer-exceeds-source-target');
  }
  if (c.ids.some(id => sum(tokens.filter(t => t.carrier === id).map(t => t.units)) !== draft.targetsUnits[id])) throw Error('allocation-token-conservation');
  const isRepayment = (t: Token) => t.claim && t.carrier === t.claim.debtorId;
  const reverseClaim = (t: Token) => !t.claim && t.trail.length ? c.candidates.find(claim =>
    claim.debtorId === t.carrier && claim.creditorId === t.origin) : undefined;
  const priority = (t: Token) => isRepayment(t) || reverseClaim(t) ? 1 : t.trail.length && t.origin !== t.carrier ? 2 : 0;
  const plan: CompiledPlan = {repayments: [], deferred: [], intents: [], funding: [], unfundedUnits: {}};
  const reserved: {claim: ClaimRef; units: number}[] = [];
  for (const id of c.ids) {
    let capacity = check.actualUnits[id] ?? 0;
    plan.unfundedUnits[id] = draft.targetsUnits[id] - capacity;
    const owned = tokens.filter(t => t.units && t.carrier === id);
    owned.sort((a, b) => priority(a) - priority(b) || ((a.claim ?? reverseClaim(a)) && (b.claim ?? reverseClaim(b)) ?
      compareClaims((a.claim ?? reverseClaim(a))!, (b.claim ?? reverseClaim(b))!) : 0));
    for (const t of owned) {
      const funded = Math.min(capacity, t.units); capacity -= funded;
      if (!funded) continue;
      const paid = part(t, funded);
      if (isRepayment(paid)) reserved.push({claim: ref(paid.claim!), units: funded});
      const route = [...paid.prior];
      if (!isRepayment(paid) && paid.trail.length && paid.origin !== paid.carrier) route.push({fromId: paid.origin, toId: paid.carrier,
        units: funded, kind: 'temporary', transferIds: paid.trail,
        ...(paid.claim ? {deferredClaim: ref(paid.claim)} : {})});
      if (route.length) plan.funding.push({carrierId: id, units: funded, route});
    }
  }
  // A new temporary C->D burden can fund D's existing debt to C. Reserve that
  // debt oldest first instead of posting an opposing claim that would cancel it
  // immediately on publication, before any of the repayment work has completed.
  let provenanceReview = false;
  for (const funding of plan.funding) {
    const reverse = funding.route.filter(t => t.kind === 'temporary' && !t.deferredClaim &&
      c.projection.projected.claims.some(c => c.debtorId === t.toId && c.creditorId === t.fromId));
    if (reverse.length && (funding.route.length !== 1 || reverse[0].toId !== funding.carrierId)) {
      provenanceReview = true;
      check.diagnostics.push({code: 'review-compound-reverse-obligation', certainty: 'fact', units: funding.units});
      continue;
    }
    const intent = reverse[0]; if (!intent) continue;
    for (const source of c.candidates) {
      if (!intent.units || source.debtorId !== intent.toId || source.creditorId !== intent.fromId) continue;
      // Subtract exact selected source intervals, not just amounts. Several
      // transfers must never reserve the same oldest prefix twice.
      let ranges: [number, number][] = [[0, source.units]];
      for (const r of reserved) {
        if (r.claim.debtorId !== source.debtorId || r.claim.creditorId !== source.creditorId ||
          r.claim.path.length !== source.path.length || r.claim.path.some((s, i) => s.lotId !== source.path[i].lotId)) continue;
        const lo = r.claim.path[0].offset - source.path[0].offset, hi = lo + r.units;
        ranges = ranges.flatMap(([a, b]) => hi <= a || lo >= b ? [[a, b]] :
          [...(a < lo ? [[a, lo] as [number, number]] : []), ...(hi < b ? [[hi, b] as [number, number]] : [])]);
      }
      for (const [lo, hi] of ranges) {
        const amount = Math.min(intent.units, hi - lo); if (!amount) continue;
        reserved.push({claim: sliceClaim(source, amount, lo), units: amount});
        intent.units -= amount; funding.units -= amount;
      }
    }
    if (intent.units) {
      provenanceReview = true;
      check.diagnostics.push({code: 'review-unavailable-reverse-obligation', certainty: 'fact', units: intent.units});
    }
  }
  plan.funding = plan.funding.filter(f => f.units);
  plan.intents = plan.funding.flatMap(f => f.route);
  // New ordinary intent can normalize the graph BEFORE a publication reserves
  // repayments. In particular C->R bypasses the oldest prefix of D->C. Rebind
  // within the same unreserved original candidate, never reserve the old prefix
  // again or borrow a different obligation's budget.
  const previewLots = new Set(c.projection.projected.claims.flatMap(claim => claim.path.map(s => s.lotId)));
  const temporaryIntents = plan.intents.filter(t => t.kind === 'temporary');
  const additions = temporaryIntents.map((intent, i) => {
    let id = `@allocation-preview/${i}`; while (previewLots.has(id)) id += '/new'; previewLots.add(id);
    return segment({debtorId: intent.fromId, creditorId: intent.toId,
      path: [{lotId: id, offset: 0, units: intent.units}]},
    {at: input.now, sequence: (c.projection.actual.events.at(-1)?.sequence ?? 0) + i + 1, lotId: id});
  });
  const normalized = normalize([...c.projection.projected.claims, ...additions],
    new Set(c.projection.actual.members.filter(m => m.active).map(m => m.id))).claims;
  for (const intent of plan.intents) {
    if (!intent.deferredClaim) continue;
    const addition = additions[temporaryIntents.indexOf(intent)], id = addition.path[0].lotId;
    const rebound: typeof plan.intents = [];
    for (const claim of normalized) {
      const index = claim.path.findIndex(s => s.lotId === id);
      if (index <= 0) continue;
      const original = c.projection.projected.claims.find(source => source.debtorId === intent.deferredClaim!.debtorId &&
        source.creditorId === intent.fromId && source.path.length === index && source.path.every((s, i) =>
          s.lotId === claim.path[i].lotId && claim.path[i].offset >= s.offset &&
          claim.path[i].offset + claim.units <= s.offset + s.units));
      if (original) rebound.push({...intent, units: claim.units,
        deferredClaim: {debtorId: original.debtorId, creditorId: original.creditorId,
          path: structuredClone(claim.path.slice(0, index))}});
    }
    if (sum(rebound.map(t => t.units)) === intent.units) {
      intent.normalizedDeferredClaims = rebound.map(t => t.deferredClaim!); continue;
    }
    // Multiple chained edits can net the intended route through a different
    // obligation. Keep its approved trail for review, never return a stale
    // source reference that overlaps a rebound repayment.
    provenanceReview = true;
    check.diagnostics.push({code: 'review-normalized-deferral-route', certainty: 'fact', units: intent.units});
  }
  const samePath = (a: ClaimRef, b: ClaimRef) => a.debtorId === b.debtorId && a.creditorId === b.creditorId &&
    a.path.length === b.path.length && a.path.every((s, i) => s.lotId === b.path[i].lotId);
  const pool = c.candidates.flatMap(source => normalized.filter(claim => samePath(source, claim)).flatMap(claim => {
    const lo = Math.max(0, ...claim.path.map((s, i) => source.path[i].offset - s.offset));
    const hi = Math.min(claim.units, ...claim.path.map((s, i) => source.path[i].offset + source.units - s.offset));
    return hi > lo ? [{source, claim: sliceClaim(claim, hi - lo, lo), units: hi - lo}] : [];
  }));
  for (const wanted of reserved) {
    let remaining = wanted.units;
    for (const entry of pool) {
      if (!remaining || !entry.units || !samePath(entry.source, wanted.claim) ||
        wanted.claim.path.some((s, i) => s.offset < entry.source.path[i].offset ||
          s.offset + s.units > entry.source.path[i].offset + entry.source.units)) continue;
      const take = Math.min(remaining, entry.units);
      plan.repayments.push({claim: sliceClaim(entry.claim, take), units: take});
      remaining -= take; entry.units -= take;
      if (entry.units) entry.claim = sliceClaim(entry.claim, entry.units, take);
    }
    if (remaining) check.diagnostics.push({code: 'repayment-deferred-after-normalization', certainty: 'fact',
      engineer: wanted.claim.debtorId, units: remaining});
  }
  // Each unreserved source slice remains outstanding, including permanent edits
  // and third-party reroutes. The latter create creditor -> carrier intent once,
  // allowing existing normalization to retain the old debtor/source age.
  for (const candidate of c.candidates) {
    let ranges: [number, number][] = [[0, candidate.units]];
    for (const p of plan.repayments.filter(p => p.claim.path[0].lotId === candidate.path[0].lotId)) {
      const lo = p.claim.path[0].offset - candidate.path[0].offset, hi = lo + p.units;
      ranges = ranges.flatMap(([a, b]) => hi <= a || lo >= b ? [[a, b]] :
        [...(a < lo ? [[a, lo] as [number, number]] : []), ...(hi < b ? [[hi, b] as [number, number]] : [])]);
    }
    for (const [a, b] of ranges) plan.deferred.push({claim: sliceClaim(candidate, b - a, a), units: b - a});
  }
  return {check, plan, confirmable: !provenanceReview, diagnostics: check.diagnostics};
}
