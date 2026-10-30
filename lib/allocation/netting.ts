import {settle} from './derive.ts';
import type {Kind} from './types.ts';

/** One netted temporary relationship, in half-point units. */
export type NettedLine = {debtorId: string; creditorId: string; units: number; thisMonth: number; later: number};
/** The compiled plan's temporary intents and this month's repayments. */
export type NettedSource = {
  transfers: readonly {fromId: string; toId: string; units: number; kind: Kind}[];
  repayments: readonly {claim: {debtorId: string; creditorId: string}; units: number}[];
};

/** Display only: who owes whom after this draft, with chains collapsed and
 * opposite directions cancelled. `opening` is the projected net at month opening
 * (positive: owed relief). Build it from the COMPILED plan: its temporary intents
 * add work owed back to the member who carries it (including deferred repayment
 * carried for a creditor), and its repayments are what is really repaid this
 * month. Permanent intents create no compensation. */
export function nettedCompensation(opening: Readonly<Record<string, number>>, plan: NettedSource, order: readonly string[]): NettedLine[] {
  const total: Record<string, number> = {...opening};
  const add = (b: Record<string, number>, id: string, units: number) => {b[id] = (b[id] ?? 0) + units;};
  for (const t of plan.transfers) if (t.kind === 'temporary') {add(total, t.toId, t.units); add(total, t.fromId, -t.units);}
  const later = {...total};
  for (const r of plan.repayments) {add(later, r.claim.debtorId, r.units); add(later, r.claim.creditorId, -r.units);}
  const lines: NettedLine[] = settle(total, order).map(f => ({...f, thisMonth: f.units, later: 0}));
  // What still carries forward stays on the same netted line wherever possible.
  for (const line of lines) {
    const units = Math.min(line.units, Math.max(0, -(later[line.debtorId] ?? 0)), Math.max(0, later[line.creditorId] ?? 0));
    line.later += units; line.thisMonth -= units; add(later, line.debtorId, units); add(later, line.creditorId, -units);
  }
  // Work repaid against the net direction can leave more owed later than before.
  for (const f of settle(later, order)) {
    const line = lines.find(l => l.debtorId === f.debtorId && l.creditorId === f.creditorId);
    if (line) {line.units += f.units; line.later += f.units;} else lines.push({...f, thisMonth: 0, later: f.units});
  }
  return lines;
}
