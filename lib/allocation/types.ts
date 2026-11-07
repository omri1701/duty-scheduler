import type {ClaimRef, ClaimSegment, CompensationEvent} from '../compensation/types.ts';
import type {GenerationInput, Diagnostic} from '../scheduling/types.ts';
import type {PrimaryAssignments} from '../scheduling/validate.ts';

/** Allocation amounts, including signed changes, are integer HALF-POINT units. */
export type AllocationInput = {
  schedule: Omit<GenerationInput, 'targets'>;
  seniority: readonly string[]; // saved order, senior first; exactly the participants
  events: readonly CompensationEvent[];
  now: number;
};
export type Kind = 'temporary' | 'permanent';
export type Repayment = {claim: ClaimSegment; units: number};
/** One member's net change of each kind, signed. Points = offered + permanent + temporary. */
export type Change = {temporary: number; permanent: number};
/** An explicit routing preference from a drag: points given by one member to another. */
export type Pair = {id: string; fromId: string; toId: string; units: number; kind: Kind};
/** One canonical derived transfer. The checked RPC re-derives the list and requires it exactly. */
export type Transfer = {id: string; fromId: string; toId: string; units: number; kind: Kind};
/** System credit for an indivisible month: part of a fitted share above the plain
 * equal split, carried temporarily for a member still below it. Derived, never
 * chosen (`uneven/<debtor>/<creditor>`); the checked RPC requires the exact list. */
export type UnevenTransfer = {id: string; fromId: string; toId: string; units: number};
/** Preserve this snapshot; never recompute its baseline from later history. */
export type AllocationDraft = {
  baselineUnits: Record<string, number>;
  offeredUnits: Record<string, number>;
  targetsUnits: Record<string, number>;
  repayments: Repayment[];
  /** Net change per member: the manager's hand changes plus the automatic balance. */
  changes: Record<string, Change>;
  pairs: Pair[];
  transfers: Transfer[];
  /** Uneven-month credit still carried after permanent changes. Absent in
   * snapshots saved before the credit existed: they carry none. */
  uneven?: UnevenTransfer[];
  sourceKey: string;
  /** Members the manager changed by hand. The automatic balance never moves them.
   * Local editing state only: it is stripped before the checked RPC persists.
   * Persisted with the plan, so reopening keeps the automatic balance flowing
   * the same way; a plan saved before it was stored infers it on review
   * (`inferHand`). */
  hand?: string[];
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
