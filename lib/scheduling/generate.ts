import {defaultSettings, type Settings} from './solver/settings.ts';
import {solveProblem, type Progress} from './solver/model.ts';
import type {SolverAdapter} from './solver/highs-adapter.ts';
import {CORE_VERSION, MODEL_VERSION, inputKey, snapshotKey, prepareGeneration, type PreparedGeneration} from './domain.ts';
import {requireGenerationWindow} from './calendar.ts';
import {validatePrepared, type PrimaryAssignments} from './validate.ts';
import {GenerationError, type Diagnostic, type GenerationInput} from './types.ts';

export type RunOptions = {now: number; seed?: number; seconds?: number; nodes?: number};
export type GenerationRequest = {
  input: GenerationInput; inputKey: string; settings: Settings; now: number;
  coreVersion: string; modelVersion: string;
};
/** Orchestration boundary: only this convenience function draws randomness.
 * Pure conversion/validation and solveProblem take explicit inputs. */
export function createGenerationRequest(input: GenerationInput, options: RunOptions): GenerationRequest {
  requireGenerationWindow(input.month, input.calendar, options.now);
  const prepared = prepareGeneration(input);
  const seed = options.seed ?? (crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff);
  const settings = {...defaultSettings, seed, seconds: options.seconds ?? 30, nodes: options.nodes ?? defaultSettings.nodes};
  if (!Number.isInteger(seed) || seed < 0 || seed > 2147483647 || !Number.isFinite(settings.seconds) || settings.seconds < 0 ||
    settings.seconds > 30 || !Number.isInteger(settings.nodes) || settings.nodes < 0 || settings.nodes > 2147483647) {
    throw new GenerationError('invalid-search-settings');
  }
  return {input: prepared.input, inputKey: prepared.key, settings, now: options.now, coreVersion: CORE_VERSION, modelVersion: MODEL_VERSION};
}
export type SolverOutput = ReturnType<typeof solveProblem>;
export type SolverVersion = SolverAdapter['version'];
export type GenerationProgress = Omit<Progress, 'assignment'> & {assignments: PrimaryAssignments};
function mapAssignments(prepared: PreparedGeneration, selected: (number | null)[]): PrimaryAssignments {
  return Object.fromEntries(prepared.duties.map((d, i) => [d.id, {
    primary: selected[i] === null ? null : prepared.members[selected[i]]?.id,
    ...(prepared.input.secondary?.[d.id] ? {secondary: prepared.input.secondary[d.id]} : {})}]));
}
export function progressReporter(prepared: PreparedGeneration, report?: (progress: GenerationProgress) => void) {
  if (!report) return undefined;
  return (progress: Progress) => {
    const assignments = mapAssignments(prepared, progress.assignment);
    const metrics = validatePrepared(prepared, assignments);
    if (JSON.stringify(metrics) !== JSON.stringify(progress.metrics)) throw new GenerationError('solver-domain-validation-mismatch');
    report({stage: progress.stage, assignments, metrics, provedPrefix: [...progress.provedPrefix]});
  };
}
export function finishGeneration(prepared: PreparedGeneration, raw: SolverOutput, request: GenerationRequest, version: SolverVersion) {
  const assignments = mapAssignments(prepared, raw.assignment);
  const metrics = validatePrepared(prepared, assignments);
  if (JSON.stringify(metrics) !== JSON.stringify(raw.metrics)) throw new GenerationError('solver-domain-validation-mismatch');
  const uncovered = prepared.duties.filter(d => assignments[d.id].primary === null);
  const diagnostics: Diagnostic[] = [...prepared.diagnostics];
  for (const d of uncovered) {
    diagnostics.push({code: 'uncovered-duty', certainty: 'fact', dutyId: d.id, dates: d.dates, units: d.units});
    for (const b of prepared.problem.boundaries ?? []) if (d.start <= b.end && b.start <= d.end) {
      diagnostics.push({code: 'binding-neighbor-restriction', certainty: 'fact', dutyId: d.id,
        engineer: prepared.members[b.engineer].id, sources: prepared.neighborSources.get(b.id)});
    }
  }
  const complete = uncovered.length === 0 && metrics.deficits.every(v => v === 0);
  const coverageProved = raw.provedPrefix.includes('coverage');
  const {assignment: discardedAssignment, metrics: discardedMetrics, ...search} = raw;
  void discardedAssignment; void discardedMetrics;
  diagnostics.push({code: complete ? 'complete-feasible' : coverageProved ? 'complete-infeasible' : 'complete-feasibility-unknown',
    certainty: complete ? 'fact' : coverageProved ? 'proved' : 'unproved'});
  const result = {
    assignments, duties: prepared.duties, metrics, diagnostics,
    engineers: prepared.members.map((e, i) => ({id: e.id, targetUnits: prepared.problem.targets[i],
      lockedUnits: prepared.duties.reduce((sum, d) => sum + (prepared.locks.get(d.id) === e.id ? d.units : 0), 0),
      assignedUnits: prepared.problem.targets[i] - metrics.deficits[i], missingUnits: metrics.deficits[i]})),
    uncoveredDates: uncovered.flatMap(d => d.dates), complete,
    completeFeasibility: complete ? 'feasible' as const : coverageProved ? 'infeasible' as const : 'unknown' as const,
    search,
    reproduction: {inputKey: request.inputKey, coreVersion: CORE_VERSION, modelVersion: MODEL_VERSION,
      solverVersion: version, settings: {...request.settings}},
  };
  // An exact snapshot binding catches accidental mutation between return and
  // acceptance. This is not an authorization token or a persistence proof.
  return {...result, resultKey: snapshotKey(result)};
}
export type GenerationResult = ReturnType<typeof finishGeneration>;
/** Recheck authoritative time and source facts immediately before accepting a
 * result. Future persistence must additionally enforce revision/auth atomically. */
export function acceptGeneration(result: GenerationResult, currentInput: GenerationInput, now: number) {
  requireGenerationWindow(currentInput.month, currentInput.calendar, now);
  if (result.reproduction.inputKey !== inputKey(currentInput) || result.reproduction.coreVersion !== CORE_VERSION ||
    result.reproduction.modelVersion !== MODEL_VERSION) throw new GenerationError('stale-generation');
  const {resultKey, ...facts} = result;
  if (resultKey !== snapshotKey(facts)) throw new GenerationError('altered-generation-result');
  const metrics = validatePrepared(prepareGeneration(currentInput), result.assignments);
  if (JSON.stringify(metrics) !== JSON.stringify(result.metrics)) throw new GenerationError('altered-generation-result');
  return result;
}
export function solveGeneration(adapter: SolverAdapter, request: GenerationRequest, onProgress?: (progress: GenerationProgress) => void) {
  const checked = createGenerationRequest(request.input, {...request.settings, now: request.now});
  if (checked.inputKey !== request.inputKey || request.coreVersion !== CORE_VERSION || request.modelVersion !== MODEL_VERSION) throw new GenerationError('stale-request');
  const prepared = prepareGeneration(request.input);
  const raw = solveProblem(adapter, prepared.problem, request.settings, progressReporter(prepared, onProgress));
  return finishGeneration(prepared, raw, request, adapter.version);
}
