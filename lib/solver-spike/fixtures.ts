import type {Problem} from './problem.ts';

/** Synthetic November-like 30-day owner range; normalized elapsed minutes. */
export function monthFixture(kind: 'normal' | 'constrained' | 'split' | 'spacing' | 'two' | 'large' = 'normal'): Problem {
  const engineers = kind === 'two' ? 2 : kind === 'large' ? 24 : 12;
  const duties: Problem['duties'] = [];
  for (let day = 0; day < 30; day++) {
    const friday = day % 7 === 5, saturday = day % 7 === 6;
    if (saturday && kind !== 'split') continue;
    const days = friday && kind !== 'split' ? 2 : 1;
    const special = kind === 'constrained' && day % 9 === 0 ? 1 : 0;
    const eligible = Array.from({length: engineers}, (_, e) => e).filter(e =>
      kind !== 'constrained' || (day === 12 ? false : (e + day * 7) % 11 < 4));
    duties.push({start: day * 1440, end: (day + days) * 1440,
      units: special ? 6 : kind === 'split' && (friday || saturday) ? 1 : 2,
      days, special, eligible, ...(friday || saturday ? {weekend: Math.floor(day / 7)} : {})});
  }
  const total = duties.reduce((n, d) => n + d.units, 0);
  const targets = Array.from({length: engineers}, (_, e) => 2 * (Math.floor(total / 2 / engineers) + (e < total / 2 % engineers ? 1 : 0)));
  if (kind === 'split') {duties[0].lock = 0; duties[8].lock = 1;}
  return {targets, duties, spacing: kind === 'spacing'};
}

/** Reuse the original fixtures unchanged; harder cases deliberately enable spacing. */
export function benchmarkFixture(name: string): Problem {
  if (['normal', 'constrained', 'split', 'spacing', 'two', 'large'].includes(name)) return monthFixture(name as Parameters<typeof monthFixture>[0]);
  const p = monthFixture(name === 'partial-spacing' ? 'constrained' : name === 'split-spacing' ? 'split' : 'spacing');
  p.spacing = true;
  if (name === 'boundary-spacing') {
    p.boundaries = p.targets.flatMap((_, e) => [
      {id: `live-${e}`, engineer: e, start: (-15 + e) * 1440, end: (-14 + e) * 1440, source: 'published'},
      {id: `draft-${e}`, engineer: e, start: (-13 + e) * 1440, end: (-12 + e) * 1440, source: 'draft'},
      {id: `next-${e}`, engineer: e, start: (30 + e) * 1440, end: (31 + e) * 1440, source: 'published'},
    ]);
  } else if (name === 'locked-zero') {
    p.duties[0].lock = 0; p.duties[1].lock = 0;
    p.exceptions = {consecutive: [[0, 1]]};
  } else if (name !== 'partial-spacing' && name !== 'split-spacing') throw Error(`Unknown fixture ${name}`);
  return p;
}
