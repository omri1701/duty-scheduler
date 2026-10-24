import type {ClaimRef, ClaimSegment, CompensationEvent} from '../compensation/types.ts';
import type {GenerationInput, Diagnostic} from '../scheduling/types.ts';
import type {PrimaryAssignments} from '../scheduling/validate.ts';

/** Allocation amounts, including signed edits, are integer HALF-POINT units. */
export type AllocationInput = {
  schedule: Omit<GenerationInput, 'targets'>;
  seniority: readonly string[]; // saved order, senior first; exactly the participants
  events: readonly CompensationEvent[];
  now: number;
};
export type Kind = 'temporary' | 'permanent';
export type Repayment = {claim: ClaimSegment; units: number};
export type Transfer = {id: string; fromId: string; toId: string; units: number; kind: Kind};
export type Pending = {id: string; engineer: string; deltaUnits: number; kind: Kind};
/** Preserve this snapshot; never recompute its baseline from later history. */
export type AllocationDraft = {
  baselineUnits: Record<string, number>;
  offeredUnits: Record<string, number>;
  targetsUnits: Record<string, number>;
  repayments: Repayment[];
  transfers: Transfer[];
  pending: Pending[];
  sourceKey: string;
};
export type Stage = {name: string; status: string; objective: number | null; proved: boolean};
export type Feasibility = 'complete' | 'partial' | 'unknown' | 'invalid';
export type Check = {
  feasibility: Feasibility; assignments: PrimaryAssignments | null;
  coverage: number; special: number; assignedUnits: number;
  actualUnits: Record<string, number>; stages: Stage[]; diagnostics: Diagnostic[];
};
export type Intent = {
  fromId: string; toId: string; units: number; kind: Kind;
  transferIds: string[]; deferredClaim?: ClaimRef;
};
export type CompiledPlan = {
  repayments: {claim: ClaimRef; units: number}[];
  deferred: {claim: ClaimRef; units: number}[];
  intents: Intent[];
  unfundedUnits: Record<string, number>;
};
