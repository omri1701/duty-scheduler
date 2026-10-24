import {normalize, sliceClaim} from '../compensation/index.ts';
import {compareClaims, segment} from '../compensation/normalize.ts';
import type {ClaimRef, ClaimSegment} from '../compensation/types.ts';
import type {Settings, SolverAdapter} from '../scheduling/solver/highs-adapter.ts';
import {budget, checkTargets, context, sum, validTargets} from './model.ts';
import {validateDraft} from './edits.ts';
import type {AllocationInput, AllocationDraft, CompiledPlan, Intent} from './types.ts';

type Token = {carrier: string; origin: string; units: number; claim?: ClaimSegment;
  trail: string[]; prior: Intent[]};
const part = (token: Token, amount: number, offset = 0): Token => ({...structuredClone(token), units: amount,
  ...(token.claim ? {claim: {...token.claim, ...sliceClaim(token.claim, amount, offset), units: amount}} : {}),
  prior: token.prior.map(p => ({...structuredClone(p), units: amount,
    ...(p.deferredClaim ? {deferredClaim: sliceClaim(p.deferredClaim, amount, offset)} : {})})),
});
const ref = (c: ClaimRef): ClaimRef => ({debtorId: c.debtorId, creditorId: c.creditorId, path: structuredClone(c.path)});

/** Compile accounting intent only after editing. No events, reservations, dates or
 * settlements are written here. Future publication must bind each funded unit
 * to exclusive real duty capacity through the existing compensation API. */
export function compileAllocation(adapter: SolverAdapter, input: AllocationInput, draft: AllocationDraft,
  settings: Partial<Settings> = {}) {
  const work = budget(settings), c = context(input); validateDraft(c, draft);
  if (draft.pending.length || !validTargets(c, draft.targetsUnits)) {
    const check = checkTargets(adapter, c, draft.targetsUnits, work);
    return {check, plan: null, confirmable: false, diagnostics: [...check.diagnostics,
      {code: 'finish-pending-allocation-edits', certainty: 'fact' as const}]};
  }
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
  const ordinary = Object.fromEntries(c.ids.map(id => [id, sum(tokens.filter(t =>
    t.carrier === id && priority(t) === 0).map(t => t.units))]));
  const reverseBudget = new Map<string, number>();
  const pair = (debtor: string, creditor: string) => JSON.stringify([debtor, creditor]);
  for (const t of tokens.filter(t => reverseClaim(t))) {
    const key = pair(t.carrier, t.origin); reverseBudget.set(key, (reverseBudget.get(key) ?? 0) + t.units);
  }
  const funding = c.candidates.flatMap(claim => {
    const selected = sum(tokens.filter(t => isRepayment(t) && t.claim!.debtorId === claim.debtorId &&
      t.claim!.creditorId === claim.creditorId && t.claim!.path[0].lotId === claim.path[0].lotId).map(t =>
      Math.max(0, Math.min(t.claim!.path[0].offset + t.units, claim.path[0].offset + claim.units) -
        Math.max(t.claim!.path[0].offset, claim.path[0].offset))));
    const key = pair(claim.debtorId, claim.creditorId), extra = Math.min(claim.units - selected, reverseBudget.get(key) ?? 0);
    reverseBudget.set(key, (reverseBudget.get(key) ?? 0) - extra);
    const possible = selected + extra;
    return possible ? [{engineer: claim.debtorId, units: possible, ordinaryUnits: ordinary[claim.debtorId]}] : [];
  });
  // Preserve coverage first, then favor witnesses that can fund the oldest final
  // repayment budgets. An arbitrary equally covered partial schedule must not
  // accidentally defer feasible compensation after manager edits.
  const check = checkTargets(adapter, c, draft.targetsUnits, work, {}, funding);
  const plan: CompiledPlan = {repayments: [], deferred: [], intents: [], unfundedUnits: {}};
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
      plan.intents.push(...paid.prior);
      if (!isRepayment(paid) && paid.trail.length && paid.origin !== paid.carrier) plan.intents.push({fromId: paid.origin, toId: paid.carrier,
        units: funded, kind: 'temporary', transferIds: paid.trail,
        ...(paid.claim ? {deferredClaim: ref(paid.claim)} : {})});
    }
  }
  // A new temporary C->D burden can fund D's existing debt to C. Reserve that
  // debt oldest first instead of posting an opposing claim that would cancel it
  // immediately on publication, before any of the repayment work has completed.
  for (const intent of plan.intents.filter(t => t.kind === 'temporary' && !t.deferredClaim)) {
    for (const source of c.candidates) {
      if (!intent.units || source.debtorId !== intent.toId || source.creditorId !== intent.fromId) continue;
      const already = sum(reserved.filter(r => r.claim.debtorId === source.debtorId && r.claim.creditorId === source.creditorId &&
        r.claim.path.length === source.path.length && r.claim.path.every((s, i) => s.lotId === source.path[i].lotId &&
          s.offset >= source.path[i].offset && s.offset + s.units <= source.path[i].offset + source.units)).map(r => r.units));
      const amount = Math.min(intent.units, source.units - already);
      if (amount) {reserved.push({claim: sliceClaim(source, amount), units: amount}); intent.units -= amount;}
    }
  }
  plan.intents = plan.intents.filter(t => t.units);
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
  let provenanceReview = false;
  plan.intents = plan.intents.flatMap(intent => {
    if (!intent.deferredClaim) return [intent];
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
    if (sum(rebound.map(t => t.units)) === intent.units) return rebound;
    // Multiple chained edits can net the intended route through a different
    // obligation. Keep its approved trail for review, never return a stale
    // source reference that overlaps a rebound repayment.
    provenanceReview = true;
    check.diagnostics.push({code: 'review-normalized-deferral-route', certainty: 'fact', units: intent.units});
    const {deferredClaim: omitted, ...unbound} = intent; void omitted; return [unbound];
  });
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
