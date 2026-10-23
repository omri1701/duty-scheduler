/** Synthetic normalized input, deliberately not a replacement for the domain core. */
export type Duty = {start: number; end: number; units: number; days: number;
  special: number; eligible: number[]; weekend?: number; lock?: number};
export type Problem = {targets: number[]; duties: Duty[]; spacing?: boolean};
export type Metrics = {coverage: number; special: number; units: number; deficits: number[]; gaps: number[]};

export function checkProblem(p: Problem) {
  const integer = (n: number) => Number.isSafeInteger(n) && n >= 0;
  if (!p.targets.length || !p.duties.length || !p.targets.every(integer)) throw Error('Invalid targets/duties');
  for (const [i, d] of p.duties.entries()) {
    if (![d.start, d.end, d.units, d.days, d.special].every(integer) || d.end <= d.start ||
      !d.units || !d.days || d.special > d.days || (i > 0 && p.duties[i - 1].end > d.start) ||
      new Set(d.eligible).size !== d.eligible.length ||
      d.eligible.some(e => !integer(e) || e >= p.targets.length) ||
      (d.weekend !== undefined && !integer(d.weekend)) ||
      (d.lock !== undefined && !d.eligible.includes(d.lock))) throw Error('Invalid normalized duty');
  }
  const total = p.targets.reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(total) || total > 1e9 || total !== p.duties.reduce((a, d) => a + d.units, 0)) throw Error('Unbalanced/oversized targets');
  validateAssignment(p, p.duties.map(d => d.lock ?? null));
}

/** Independent of LP generation and HiGHS. Never rounds fractional assignments. */
export function validateAssignment(p: Problem, assignment: (number | null)[]): Metrics {
  if (assignment.length !== p.duties.length) throw Error('Wrong assignment length');
  const used = p.targets.map(() => 0), weekends = p.targets.map(() => new Set<number>());
  const previous = p.targets.map(() => -1), gaps: number[] = [];
  let coverage = 0, special = 0;
  assignment.forEach((e, i) => {
    const d = p.duties[i];
    if (d.lock !== undefined && d.lock !== e) throw Error('Missing lock');
    if (e === null) return;
    if (!Number.isInteger(e) || !d.eligible.includes(e)) throw Error('Ineligible/fractional assignment');
    used[e] += d.units;
    if (used[e] > p.targets[e]) throw Error('Target exceeded');
    if (d.weekend !== undefined) weekends[e].add(d.weekend);
    if (weekends[e].size > 1) throw Error('Weekend cap exceeded');
    if (previous[e] >= 0) {
      const gap = d.start - p.duties[previous[e]].end;
      if (gap <= 0) throw Error('Consecutive/overlapping duties');
      gaps.push(gap);
    }
    previous[e] = i;
    coverage += d.days; special += d.special;
  });
  return {coverage, special, units: used.reduce((a, b) => a + b, 0),
    deficits: used.map((n, e) => p.targets[e] - n), gaps: gaps.sort((a, b) => a - b)};
}

export function decodeAssignment(p: Problem, values: Record<string, number>) {
  return p.duties.map((d, i) => {
    const selected = d.eligible.filter(e => {
      const n = values[`x_${e}_${i}`];
      if (n !== 0 && n !== 1) throw Error('Non-binary/missing solver value');
      return n === 1;
    });
    if (selected.length > 1) throw Error('Duplicate primary');
    return selected[0] ?? null;
  });
}

/** Only absorb native binary endpoint noise; domain validation remains exact. */
export function binaryValues(values: Record<string, number>) {
  return Object.fromEntries(Object.entries(values).map(([key, n]) => {
    if (!Number.isFinite(n) || Math.min(Math.abs(n), Math.abs(n - 1)) > 1e-8) throw Error('Non-binary solver value');
    return [key, Math.abs(n) <= 1e-8 ? 0 : 1];
  }));
}
