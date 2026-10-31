export type Calendar = {
  specials?: {id: string; start: string; end: string; extra: number}[];
  splitWeekends?: string[];
  specialDates?: string[];
};
export type Member = {id: string; active: boolean; approved: boolean; eligible: boolean};
export type Neighbor = {
  id: string; ownerMonth: string; start: string; end: string; engineer: string;
  source: 'published' | 'working';
};
export type Approval = {reason: string} & (
  {rule: 'availability'; dutyId: string; engineer: string; dates: string[]} |
  {rule: 'consecutive'; duties: [string, string]} |
  {rule: 'boundary'; dutyId: string; neighborId: string} |
  {rule: 'weekends'; engineer: string; weekends: string[]}
);
/** Confirmed points, never a proposal. No prior unlocked primaries are imported. */
export type GenerationInput = {
  month: string; sourceRevision: string; calendar: Calendar; members: Member[];
  targets: Record<string, number>;
  constraints?: Record<string, Record<string, 'no' | 'prefer'>>;
  locks?: {dutyId: string; engineer: string}[];
  secondary?: Record<string, string>;
  neighbors?: Neighbor[];
  approvals?: Approval[];
  /** Weekend turns per member in the current rotation cycle (see rotation.ts); absent members count 0. */
  weekendRotation?: Record<string, number>;
  /** Sunday–Thursday duties per weekday (index 0–4) per member in the current cycle (see rotation.ts); absent members count 0. */
  weekdayRotation?: Record<string, number[]>;
};
export type CanonicalDuty = {
  id: string; ownerMonth: string; startDate: string; endDate: string; dates: string[];
  start: number; end: number; units: number; specialDates: string[]; weekendId?: string;
};
export type Diagnostic = {
  code: string; certainty: 'fact' | 'proved' | 'unproved';
  engineer?: string; dutyId?: string; dates?: string[]; sources?: string[]; units?: number;
  engineers?: string[]; targetUnits?: number; capacityUnits?: number;
};
export class GenerationError extends Error {
  code: string;
  detail: Record<string, unknown>;
  constructor(code: string, detail: Record<string, unknown> = {}) {
    super(code); this.name = 'GenerationError'; this.code = code; this.detail = detail;
  }
}
