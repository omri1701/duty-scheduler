// Shared helpers of the allocation fuzzers: a seeded random stream and a greedy valid
// primary assignment toward the targets (no solver).
import {canonicalDuties} from '../../lib/scheduling/calendar.ts';
import {validateGeneration} from '../../lib/scheduling/validate.ts';

export function rng(seed) {let s = seed >>> 0; return () => {s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296;};}
export const pick = (r, xs) => xs[Math.floor(r() * xs.length)];

export function lockedOf(i) {
  const duties = canonicalDuties(i.schedule.month, i.schedule.calendar), locked = Object.fromEntries(i.seniority.map(id => [id, 0]));
  for (const l of i.schedule.locks ?? []) locked[l.engineer] += duties.find(d => d.id === l.dutyId).units;
  return locked;
}
/** Greedy valid primary assignment toward targets (may be partial); no solver. */
export function greedy(i, d) {
  let best = null;
  for (let k = 0; k < 8; k++) {
    const a = greedyOnce(i, d, k); if (!a) continue;
    const missing = Object.values(a).filter(x => x.primary === null).length;
    if (!best || missing < best.missing) best = {a, missing};
    if (!missing) break;
  }
  return best?.a ?? null;
}
function greedyOnce(i, d, k) {
  const jitter = rng(k * 7919 + 1), duties = canonicalDuties(i.schedule.month, i.schedule.calendar), out = {}, got = {}, last = {}, weekends = {};
  for (const id of i.seniority) {got[id] = 0; weekends[id] = new Set();}
  const lock = Object.fromEntries((i.schedule.locks ?? []).map(l => [l.dutyId, l.engineer]));
  for (const du of duties) if (lock[du.id]) got[lock[du.id]] += du.units;
  for (const du of duties) {
    let chosen = lock[du.id] ?? null;
    if (!chosen) {
      const ok = i.seniority.filter(id => got[id] + du.units <= d.targetsUnits[id] &&
        !du.dates.some(x => i.schedule.constraints?.[id]?.[x] === 'no') && !(last[id] !== undefined && last[id] >= du.start) &&
        !(du.weekendId && weekends[id].size && !weekends[id].has(du.weekendId)) &&
        !(i.schedule.neighbors ?? []).some(n => n.engineer === id) &&
        !duties.some(o => lock[o.id] === id && (o.start === du.end || o.end === du.start || (o.start < du.end && du.start < o.end))));
      const weight = Object.fromEntries(ok.map(id => [id, (d.targetsUnits[id] - got[id]) + (k ? jitter() * 3 : 0)]));
      ok.sort((a, b) => weight[b] - weight[a]); chosen = ok[0] ?? null;
      if (chosen) got[chosen] += du.units;
    }
    out[du.id] = {primary: chosen, ...(i.schedule.secondary?.[du.id] ? {secondary: i.schedule.secondary[du.id]} : {})};
    if (chosen) {last[chosen] = du.end; if (du.weekendId) weekends[chosen].add(du.weekendId);}
  }
  try {validateGeneration({...i.schedule, targets: Object.fromEntries(i.seniority.map(id => [id, d.targetsUnits[id] / 2]))}, out); return out;}
  catch {return null;}
}
export const holes = i => {const lock = Object.fromEntries((i.schedule.locks ?? []).map(l => [l.dutyId, l.engineer]));
  return Object.fromEntries(canonicalDuties(i.schedule.month, i.schedule.calendar).map(du => [du.id, {primary: lock[du.id] ?? null}]));};
