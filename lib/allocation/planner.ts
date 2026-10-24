import {buildModel} from '../scheduling/solver/model.ts';
import type {SolverAdapter, Settings, Term} from '../scheduling/solver/highs-adapter.ts';
import {sliceClaim} from '../compensation/index.ts';
import {assignments, budget, checkTargets, context, model, scale, sum, value, type Context} from './model.ts';
import type {AllocationInput, AllocationDraft, Check, Transfer} from './types.ts';

/** Pure domain proposal; the injected adapter owns WASM initialization.
 * Date placement, spacing, preferences and randomized ties remain Generate's job. */
export function proposeAllocation(adapter: SolverAdapter, input: AllocationInput, settings: Partial<Settings> = {}) {
  const work = budget(settings), c = context(input), m = model(adapter, work), n = c.ids.length;
  const bs: Term[][] = c.ids.map(() => []), cost: Term[] = [];
  const attainable = new Set([0]);
  for (const d of c.prepared.duties) for (const v of [...attainable]) attainable.add(v + d.units);
  const totals = [...attainable].sort((a, b) => a - b);
  try {
    if (!Number.isSafeInteger(n * (n * c.total) ** 2)) throw Error('allocation-fairness-cost-overflow');
    // Ordinary responsibility is a partition of real weighted blocks, independent
    // of personal availability and locks. Neither relief nor locks erase B.
    for (const [i] of c.prepared.duties.entries()) {
      m.addColumns(c.ids.map((_, e) => ({name: `ordinary_${e}_${i}`})));
      m.addRows([{terms: c.ids.map((_, e) => [1, `ordinary_${e}_${i}`]), lower: 1, upper: 1}]);
    }
    for (let e = 0; e < n; e++) {
      const choices: Term[] = [];
      for (const t of totals) {
        const key = `baseline_${e}_${t}`; m.addColumns([{name: key}]);
        choices.push([1, key]); bs[e].push([t, key]); cost.push([(n * t - c.total) ** 2, key]);
      }
      m.addRows([{terms: choices, lower: 1, upper: 1}, {terms: [...bs[e],
        ...c.prepared.duties.map((d, i) => [-d.units, `ordinary_${e}_${i}`] as Term)], lower: 0, upper: 0}]);
    }
    let proved = m.optimize('ordinary-fairness', cost), ordinary = m.values;
    const base = buildModel(c.prepared.problem, true);
    const repayments: Term[][] = [], flows: {from: number; to: number; terms: Term[]}[] = [];
    const targetTerms: Term[][] = bs.map(t => [...t]);
    if (proved) {
      m.addColumns(base.columns); m.addRows(base.rows);
      for (const [i, claim] of c.candidates.entries()) {
        const t = m.integer(`repay_${i}`, Math.min(claim.units, c.total)); repayments.push(t);
        targetTerms[c.ids.indexOf(claim.debtorId)].push(...t);
        targetTerms[c.ids.indexOf(claim.creditorId)].push(...scale(t, -1));
      }
      // Offered compensation must itself be a partition of canonical weights.
      // Relief may repair personal availability; it cannot manufacture a fractional
      // repayment by borrowing a new temporary burden to round an indivisible duty.
      for (const [i] of c.prepared.duties.entries()) {
        m.addColumns(c.ids.map((_, e) => ({name: `offered_${e}_${i}`})));
        m.addRows([{terms: c.ids.map((_, e) => [1, `offered_${e}_${i}`]), lower: 1, upper: 1}]);
      }
      for (let e = 0; e < n; e++) m.addRows([{terms: [...targetTerms[e],
        ...c.prepared.duties.map((d, i) => [-d.units, `offered_${e}_${i}`] as Term)], lower: 0, upper: 0}]);
      for (let e = 0; e < n; e++) for (let f = 0; f < n; f++) if (e !== f) {
        const t = m.integer(`relief_${e}_${f}`, c.total); flows.push({from: e, to: f, terms: t});
        targetTerms[e].push(...scale(t, -1)); targetTerms[f].push(...t);
      }
      for (let e = 0; e < n; e++) {
        const out = flows.filter(f => f.from === e).flatMap(f => f.terms);
        const incoming = flows.filter(f => f.to === e).flatMap(f => f.terms);
        const owing = c.candidates.flatMap((claim, i) => claim.debtorId === c.ids[e] ? repayments[i] : []);
        const owed = c.candidates.flatMap((claim, i) => claim.creditorId === c.ids[e] ? repayments[i] : []);
        const assigned: Term[] = c.prepared.problem.duties.flatMap((d, i) =>
          d.eligible.includes(e) ? [[d.units, `x_${e}_${i}`] as Term] : []);
        const donor = `donor_${e}`, receiver = `receiver_${e}`, payer = `payer_${e}`, creditor = `creditor_${e}`;
        m.addColumns([donor, receiver, payer, creditor].map(name => ({name})));
        m.addRows([
          {terms: targetTerms[e], lower: c.locked[c.ids[e]], upper: c.total},
          {terms: [...assigned, ...scale(targetTerms[e], -1)], upper: 0},
          {terms: [...out, [-c.total, donor]], upper: 0},
          {terms: [...incoming, [-c.total, receiver]], upper: 0},
          {terms: [[1, donor], [1, receiver]], upper: 1},
          // Automatic recipients must actually carry all accepted work, including
          // in partial months. Ordinary relief cannot fund fictitious repayment.
          {terms: [...assigned, ...scale(targetTerms[e], -1), [-c.total, receiver]], lower: -c.total},
          {terms: [...owing, [-c.total, payer]], upper: 0},
          {terms: [...out, [c.total, payer]], upper: c.total},
          {terms: [...assigned, ...scale(bs[e], -1), ...scale(owing, -1), [-c.total, payer]], lower: -c.total},
          {terms: [...owed, [-c.total, creditor]], upper: 0},
          {terms: [...incoming, [c.total, creditor]], upper: c.total},
          {terms: [...out, ...owed, ...scale(bs[e], -1)], upper: 0},
        ]);
      }
      for (const s of base.stages) if (proved) proved = m.optimize(s.name, s.terms);
      for (const [i, t] of repayments.entries()) if (proved) proved = m.optimize(`repayment:${i}`, scale(t, -1));
      if (proved) proved = m.optimize('minimum-temporary-relief', flows.flatMap(f => f.terms));
      // Fix the chosen ordinary baseline only after equivalent fair vectors have
      // competed on oldest-feasible repayment. Seniority never defeats repayment.
      for (const id of [...input.seniority].reverse()) if (proved) {
        proved = m.optimize(`seniority:${id}`, scale(bs[c.ids.indexOf(id)], -1));
      }
      if (proved && m.values && sum(flows.map(f => value(f.terms, m.values!))) > 0) {
        for (const id of input.seniority) {
          const e = c.ids.indexOf(id), position = input.seniority.indexOf(id);
          for (let k = 1; k < n; k++) {
            const f = c.ids.indexOf(input.seniority[(position + k) % n]);
            if (proved) proved = m.optimize(`counterpart:${id}:${c.ids[f]}`,
              scale(flows.find(flow => flow.from === e && flow.to === f)!.terms, -1));
          }
        }
      }
    }
    const values = m.values, hasSchedule = !!values && Object.hasOwn(values, 'dummy');
    ordinary = hasSchedule ? values : ordinary;
    // Even a zero-budget proposal retains a balanced nominal weighted baseline.
    const fallback = Object.fromEntries(c.ids.map(id => [id, 0]));
    for (const d of c.prepared.duties) {
      const id = [...input.seniority].reverse().sort((a, b) => fallback[a] - fallback[b])[0]; fallback[id] += d.units;
    }
    const baseline = ordinary ? Object.fromEntries(c.ids.map((id, e) => [id, value(bs[e], ordinary!)])) : fallback;
    const targets = hasSchedule ? Object.fromEntries(c.ids.map((id, e) => [id, value(targetTerms[e], values!)])) : {...baseline};
    const transfers: Transfer[] = hasSchedule ? flows.flatMap(f => {
      const amount = value(f.terms, values!);
      return amount ? [{id: `proposal/${f.from}/${f.to}`, kind: 'temporary' as const,
        fromId: c.ids[f.from], toId: c.ids[f.to], units: amount}] : [];
    }) : [];
    const draft: AllocationDraft = {baselineUnits: baseline, offeredUnits: {...baseline}, targetsUnits: targets,
      repayments: hasSchedule ? c.candidates.flatMap((claim, i) => {
        const amount = value(repayments[i], values!); return amount ? [{claim: {...claim, ...sliceClaim(claim, amount), units: amount}, units: amount}] : [];
      }) : [], transfers, pending: [], sourceKey: c.key};
    for (const r of draft.repayments) {
      draft.offeredUnits[r.claim.debtorId] += r.units; draft.offeredUnits[r.claim.creditorId] -= r.units;
    }
    let check: Check;
    if (hasSchedule) {
      const a = assignments(c, values!, targets), full = a.metrics.coverage === sum(c.prepared.problem.duties.map(d => d.days));
      const coverageProved = base.stages.every(s => m.stages.some(t => t.name === s.name && t.proved));
      check = {feasibility: full ? 'complete' : coverageProved ? 'partial' : 'unknown', assignments: a.result,
        coverage: a.metrics.coverage, special: a.metrics.special, assignedUnits: a.metrics.units,
        actualUnits: a.actual, stages: [...m.stages], diagnostics: c.prepared.diagnostics.filter(d =>
          !['insufficient-individual-capacity', 'unreachable-target-combination', 'shared-capacity-shortage'].includes(d.code))};
      if (!full) check.diagnostics.push({code: coverageProved ? 'allocation-requires-partial-output' : 'allocation-feasibility-unproved',
        certainty: coverageProved ? 'proved' : 'unproved'});
      for (const d of c.prepared.duties) if (a.result[d.id].primary === null) check.diagnostics.push({code: 'uncovered-duty',
        certainty: 'fact', dutyId: d.id, dates: d.dates, units: d.units});
    } else {
      check = checkTargets(adapter, c, targets, work); check.stages = [...m.stages, ...check.stages];
    }
    if (!proved) check.diagnostics.push({code: 'allocation-optimum-unproved', certainty: 'unproved'});
    if (transfers.length) check.diagnostics.push({code: 'confirm-temporary-counterparts', certainty: 'fact'});
    for (const id of c.ids) {
      if (c.locked[id] > draft.offeredUnits[id]) check.diagnostics.push({code: 'classify-locked-target-increase',
        certainty: 'fact', engineer: id, units: c.locked[id] - draft.offeredUnits[id]});
      if (check.actualUnits[id] < targets[id]) check.diagnostics.push({code: 'unfunded-target', certainty: 'fact',
        engineer: id, units: targets[id] - check.actualUnits[id]});
    }
    return {draft, check, projection: c.projection, optimal: proved,
      reviewRequired: transfers.length > 0 || check.diagnostics.some(d => d.code === 'classify-locked-target-increase')};
  } finally {m.dispose();}
}

/** Validates manager-confirmed ceilings verbatim, even when knowingly partial. */
export function assessAllocation(adapter: SolverAdapter, input: AllocationInput, draft: AllocationDraft,
  settings: Partial<Settings> = {}) {
  const c = context(input); assertCurrent(c, draft);
  return checkTargets(adapter, c, draft.targetsUnits, budget(settings));
}
export function assertCurrent(c: Context, draft: AllocationDraft) {
  if (draft.sourceKey !== c.key) throw Error('stale-allocation');
}
