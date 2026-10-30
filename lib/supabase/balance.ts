import type {DutyClient} from './rpc.ts';

export type BalanceKind = 'temporary' | 'change' | 'repayment' | 'manual' | 'correction' | 'routed' | 'other';
/** One explanation for memberId's projected relationship with counterpartId, in half-point units. */
export type BalanceLine = {memberId: string; counterpartId: string; units: number; kind: BalanceKind;
  date: string | null; month: string | null};
/** Display-only projection of published schedules. Members receive only their own row. */
export type Balance = {net: Record<string, number>; lines: BalanceLine[]};

const kinds: readonly string[] = ['temporary', 'change', 'repayment', 'manual', 'correction', 'routed', 'other'];
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v);
const nullable = (v: unknown, pattern: RegExp) => v === null || (typeof v === 'string' && pattern.test(v));

export function readBalance(value: unknown): Balance {
  if (!object(value) || !object(value.net) || !Array.isArray(value.lines) || Object.values(value.net).some(n => !integer(n)) ||
    value.lines.some(l => !object(l) || typeof l.memberId !== 'string' || typeof l.counterpartId !== 'string' ||
      !integer(l.units) || !kinds.includes(String(l.kind)) || !nullable(l.date, /^\d{4}-\d{2}-\d{2}$/) || !nullable(l.month, /^\d{4}-\d{2}$/)))
    throw Error('Invalid balance');
  return structuredClone(value as Balance);
}

export async function balance(client: DutyClient) {
  const {data, error} = await client.rpc('duty_balance');
  if (error) throw error;
  return readBalance(data);
}

/** Positive: owed relief. Negative: owes work. Units are half-points. */
export const signedPoints = (units: number) => (units > 0 ? '+' : units < 0 ? '−' : '') + Math.abs(units) / 2;

/** One line per open relationship, net of its sources and scheduled repayments. */
export function relationships(b: Balance, memberId: string) {
  const groups = new Map<string, BalanceLine[]>();
  for (const line of b.lines) if (line.memberId === memberId) groups.set(line.counterpartId, [...groups.get(line.counterpartId) ?? [], line]);
  return [...groups].map(([counterpartId, lines]) => ({counterpartId, units: lines.reduce((sum, l) => sum + l.units, 0), lines}))
    .filter(r => r.units);
}
