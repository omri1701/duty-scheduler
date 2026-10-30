import type {AllocationDraft} from './types.ts';

/** One netted temporary relationship, in half-point units. `reason` names a
 * system credit: 'uneven' when this pair carries an indivisible month's extra. */
export type NettedLine = {debtorId: string; creditorId: string; units: number; thisMonth: number; later: number; reason?: 'uneven'};

type Flow = {debtorId: string; creditorId: string; units: number};

/** Pairs net debtors with net creditors: largest first, then the given order. */
function settle(balance: Record<string, number>, rank: (id: string) => number): Flow[] {
  const side = (sign: number) => Object.keys(balance).filter(id => Math.sign(balance[id]) === sign)
    .map(id => ({id, units: Math.abs(balance[id])})).sort((a, b) => b.units - a.units || rank(a.id) - rank(b.id));
  const debtors = side(-1), creditors = side(1), flows: Flow[] = [];
  for (let d = 0, c = 0; d < debtors.length && c < creditors.length;) {
    const units = Math.min(debtors[d].units, creditors[c].units);
    flows.push({debtorId: debtors[d].id, creditorId: creditors[c].id, units});
    debtors[d].units -= units; creditors[c].units -= units;
    if (!debtors[d].units) d++;
    if (!creditors[c].units) c++;
  }
  return flows;
}

/** Display only: who owes whom after this draft, with chains collapsed and
 * opposite directions cancelled. `opening` is the projected net at month opening
 * (positive: owed relief). Temporary transfers and uneven-month credit add work
 * owed back to the member who carries it; this month's repayments reduce what
 * remains for later. Permanent transfers and pending edits create no compensation. */
export function nettedCompensation(opening: Readonly<Record<string, number>>,
  draft: Pick<AllocationDraft, 'transfers' | 'repayments' | 'uneven'>, order: readonly string[]): NettedLine[] {
  const total: Record<string, number> = {...opening};
  const add = (b: Record<string, number>, id: string, units: number) => {b[id] = (b[id] ?? 0) + units;};
  for (const t of draft.transfers) if (t.kind === 'temporary') {add(total, t.toId, t.units); add(total, t.fromId, -t.units);}
  for (const u of draft.uneven ?? []) {add(total, u.toId, u.units); add(total, u.fromId, -u.units);}
  const later = {...total};
  for (const r of draft.repayments) {add(later, r.claim.debtorId, r.units); add(later, r.claim.creditorId, -r.units);}
  const rank = (id: string) => {const i = order.indexOf(id); return i < 0 ? order.length : i;};
  const lines: NettedLine[] = settle(total, rank).map(f => ({...f, thisMonth: f.units, later: 0}));
  // What still carries forward stays on the same netted line wherever possible.
  for (const line of lines) {
    const units = Math.min(line.units, Math.max(0, -(later[line.debtorId] ?? 0)), Math.max(0, later[line.creditorId] ?? 0));
    line.later += units; line.thisMonth -= units; add(later, line.debtorId, units); add(later, line.creditorId, -units);
  }
  // Work repaid against the net direction can leave more owed later than before.
  for (const f of settle(later, rank)) {
    const line = lines.find(l => l.debtorId === f.debtorId && l.creditorId === f.creditorId);
    if (line) {line.units += f.units; line.later += f.units;} else lines.push({...f, thisMonth: 0, later: f.units});
  }
  for (const line of lines) if ((draft.uneven ?? []).some(u => u.fromId === line.debtorId && u.toId === line.creditorId)) line.reason = 'uneven';
  return lines;
}
