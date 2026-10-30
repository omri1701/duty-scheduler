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
/** System credit for an indivisible month: `toId` carries `units` of ordinary
 * work above the plain equal split for `fromId`, who has fewer points. Targets
 * are unchanged; publication records it like a temporary transfer. IDs are
 * `uneven/<fromId>/<toId>`; the checked database derives and verifies the set. */
export type UnevenTransfer = {id: string; fromId: string; toId: string; units: number};
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
  /** Absent in snapshots saved before uneven months earned credit. */
  uneven?: UnevenTransfer[];
  /** Members the manager changed by hand. Automatic counterparts never move them.
   * Local editing state only: it is stripped before the checked RPC persists. */
  handEdited?: string[];
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
  /** Original approved reference above stays immutable through normalization. */
  normalizedDeferredClaims?: ClaimRef[];
};
export type CompiledPlan = {
  repayments: {claim: ClaimRef; units: number}[];
  deferred: {claim: ClaimRef; units: number}[];
  intents: Intent[];
  /** Each route shares ONE unit budget on its final carrier, including permanent legs. */
  funding: {carrierId: string; units: number; route: Intent[]}[];
  unfundedUnits: Record<string, number>;
};
