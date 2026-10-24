/** All amounts are integer half-points. Instants are UTC milliseconds, never dates/minutes. */
export type Units = number;
export type Member = {id: string; active: boolean};
export type Priority = {at: number; sequence: number; lotId: string};
export type SourceSlice = {lotId: string; offset: Units; units: Units};
export type ClaimRef = {debtorId: string; creditorId: string; path: readonly SourceSlice[]};
export type ClaimSegment = ClaimRef & {id: string; units: Units; priority: Priority; frozen: boolean};
export type SourceLot = {
  id: string; debtorId: string; creditorId: string; units: Units; remaining: Units;
  correctedUnits: Units; priority: Priority; sourceKey: string; correctionOf?: string;
};
/** Capacity belongs to a primary's owned date atom. Combined weekends have one unit per date. */
export type CapacitySlice = {date: string; offset: Units; units: Units};
export type PublishedDuty = {startDate: string; endDate: string; primaryId: string; units: Units};
export type TransferIntent = {
  id: string; kind: 'temporary' | 'permanent'; fromId: string; toId: string;
  capacity: readonly CapacitySlice[];
  /** Ordered accounting legs funded once by final toId. The checked database
   * boundary independently validates their source and counterpart budgets. */
  route?: readonly {fromId: string; toId: string; kind: 'temporary' | 'permanent';
    transferIds: readonly string[]; deferredClaim?: ClaimRef;
    counterparts: readonly {id: string; fromId: string; toId: string; units: Units;
      kind: 'temporary' | 'permanent'}[]}[];
};
export type Reservation = {id: string; capacity: CapacitySlice; claim: ClaimRef};
export type Publication = {
  id: string; month: string; duties: readonly PublishedDuty[];
  intents: readonly TransferIntent[]; reservations: readonly Reservation[];
};
export type Contribution = Reservation & {
  endInstantMs: number; status: 'pending' | 'held' | 'cancelled' | 'settled';
  holdReason?: string; settlementId?: string;
};
export type ManualOperation =
  | {kind: 'claim'; debtorId: string; creditorId: string; units: Units}
  | {kind: 'adjust'; claim: ClaimRef; units: Units; mode: 'reduce' | 'settle'}
  | {kind: 'correct'; lotId: string; deltaUnits: number}
  | {kind: 'reverse-settlement'; settlementId: string}
  | {kind: 'release'; contributionId: string};
export type Operation = ManualOperation
  | {kind: 'members'; members: readonly Member[]}
  | {kind: 'publication'; month: string; beforeId: string | null; after: Publication | null; mode?: 'delete'};
export type InternalOperation =
  | {kind: 'earned'; contributionId: string}
  | {kind: 'hold'; contributionId: string; reason: string};
export type Command = {sourceKey: string; at: number; actor: string; reason?: string; operation: Operation};
/** Assigned by record/reconcile; persistence must retain sequence and enforce sourceKey uniqueness. */
export type CompensationEvent = Omit<Command, 'operation'> & {
  sequence: number; operation: Operation | InternalOperation;
};
export type NormalizationStep = {
  kind: 'opposing' | 'cycle' | 'chain'; units: Units; paths: readonly (readonly SourceSlice[])[];
};
export type Settlement = {id: string; claim: ClaimRef; units: Units; reversed: boolean; contributionId?: string};
export type LedgerView = {
  events: readonly CompensationEvent[]; members: readonly Member[]; lots: readonly SourceLot[];
  claims: readonly ClaimSegment[]; contributions: readonly Contribution[];
  settlements: readonly Settlement[]; normalizations: readonly NormalizationStep[];
  publications: readonly Publication[]; net: Readonly<Record<string, number>>;
};
export class CompensationError extends Error {
  code: string;
  constructor(code: string) {super(code); this.code = code; this.name = 'CompensationError';}
}
