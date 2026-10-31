/** Normalized solver input. Minutes represent actual instants, including DST. */
export type Duty = {start: number; end: number; units: number; days: number;
  special: number; eligible: number[]; weekend?: number; lock?: number;
  /** Sunday–Thursday calendar weekday (0–4) of an ordinary daily duty; weekend halves omit it. */
  weekday?: number};
export type Boundary = {id: string; engineer: number; start: number; end: number; source: string};
export type Problem = {targets: number[]; duties: Duty[]; spacing?: boolean; boundaries?: Boundary[];
  preferences?: {duty: number; engineer: number; weight: number}[]; seededTies?: boolean;
  /** Weekend turns already taken in the current rotation cycle, per engineer. */
  rotation?: number[];
  /** Sunday–Thursday duties already taken on each weekday (0–4) in the current cycle, per engineer. */
  weekdays?: number[][];
  exceptions?: {consecutive?: [number, number][]; boundary?: {duty: number; boundary: string}[];
    weekends?: {engineer: number; weekends: number[]}[]}};
/** Ordered objective facts: coverage, special, units, the minimum gap, weekend
 * rotation cost, same-weekday repeats, cross-month weekday rotation cost, the
 * preferred-date count, then (below the seed) the whole ascending gap vector. */
export type Metrics = {coverage: number; special: number; units: number; deficits: number[]; gaps: number[];
  rotation: number; preferred: number; repeats: number; weekdays: number};

export function approvedPair(p: Problem, i: number, j: number) {
  return p.exceptions?.consecutive?.some(([a, b]) => a === i && b === j) ?? false;
}
export function approvedBoundary(p: Problem, i: number, b: Boundary) {
  return p.exceptions?.boundary?.some(a => a.duty === i && a.boundary === b.id) ?? false;
}
export function anchors(p: Problem, e: number) {
  const bindings = (p.boundaries ?? []).filter(b => b.engineer === e);
  return {
    before: bindings.filter(b => b.end <= p.duties[0].start).sort((a, b) => b.end - a.end)[0],
    after: bindings.filter(b => b.start >= p.duties.at(-1)!.end).sort((a, b) => a.start - b.start)[0],
  };
}

export function checkProblem(p: Problem) {
  const integer = (n: number) => Number.isSafeInteger(n) && n >= 0;
  const instant = (n: number) => Number.isSafeInteger(n) && Math.abs(n) <= 1e12;
  const engineer = (e: number) => integer(e) && e < p.targets.length;
  const index = (i: number) => integer(i) && i < p.duties.length;
  if (!p.targets.length || !p.duties.length || !p.targets.every(integer)) throw Error('Invalid targets/duties');
  for (const [i, d] of p.duties.entries()) {
    if (![d.start, d.end].every(instant) || ![d.units, d.days, d.special].every(integer) || d.end <= d.start ||
      !d.units || !d.days || d.special > d.days || (i > 0 && p.duties[i - 1].end > d.start) ||
      new Set(d.eligible).size !== d.eligible.length || d.eligible.some(e => !engineer(e)) ||
      (d.weekend !== undefined && !integer(d.weekend)) ||
      (d.weekday !== undefined && (!integer(d.weekday) || d.weekday > 4 || d.weekend !== undefined)) ||
      (d.lock !== undefined && !d.eligible.includes(d.lock))) throw Error('Invalid normalized duty');
  }
  if (p.rotation !== undefined && (p.rotation.length !== p.targets.length || !p.rotation.every(integer))) throw Error('Invalid rotation state');
  if (p.weekdays !== undefined && (p.weekdays.length !== p.targets.length ||
    !p.weekdays.every(w => Array.isArray(w) && w.length === 5 && w.every(integer)))) throw Error('Invalid weekday rotation state');
  const total = p.targets.reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(total) || total > 1e9 || total !== p.duties.reduce((a, d) => a + d.units, 0)) throw Error('Unbalanced/oversized targets');
  const preferences = new Set<string>();
  for (const v of p.preferences ?? []) {
    const key = `${v.duty}:${v.engineer}`;
    if (!index(v.duty) || !p.duties[v.duty].eligible.includes(v.engineer) || !integer(v.weight) ||
      !v.weight || preferences.has(key)) throw Error('Invalid preference');
    preferences.add(key);
  }
  const boundaryIds = new Set<string>();
  for (const b of p.boundaries ?? []) {
    if (!b.id || !b.source || boundaryIds.has(b.id) || !engineer(b.engineer) ||
      !instant(b.start) || !instant(b.end) || b.end <= b.start ||
      !(b.end <= p.duties[0].start || b.start >= p.duties.at(-1)!.end)) throw Error('Invalid boundary');
    boundaryIds.add(b.id);
  }
  for (const [i, j] of p.exceptions?.consecutive ?? []) {
    if (!index(i) || !index(j) || i >= j || p.duties[i].lock === undefined ||
      p.duties[i].lock !== p.duties[j].lock || p.duties[i].end !== p.duties[j].start) throw Error('Invalid fixed-pair approval');
  }
  for (const a of p.exceptions?.boundary ?? []) {
    const b = p.boundaries?.find(b => b.id === a.boundary), d = p.duties[a.duty];
    if (!index(a.duty) || !b || d.lock !== b.engineer ||
      !(b.end === d.start || d.end === b.start)) throw Error('Invalid boundary approval');
  }
  const weekendEngineers = new Set<number>();
  for (const a of p.exceptions?.weekends ?? []) {
    const locked = new Set(p.duties.filter(d => d.lock === a.engineer && d.weekend !== undefined).map(d => d.weekend));
    if (!engineer(a.engineer) || weekendEngineers.has(a.engineer) || a.weekends.length < 2 ||
      new Set(a.weekends).size !== a.weekends.length || a.weekends.length !== locked.size ||
      a.weekends.some(w => !integer(w) || !locked.has(w))) throw Error('Invalid locked-weekend approval');
    weekendEngineers.add(a.engineer);
  }
  validateAssignment(p, p.duties.map(d => d.lock ?? null));
}

/** Independent of model construction, threshold search, flow variables and HiGHS. */
export function validateAssignment(p: Problem, assignment: (number | null)[]): Metrics {
  if (assignment.length !== p.duties.length) throw Error('Wrong assignment length');
  const used = p.targets.map(() => 0), weekends = p.targets.map(() => new Set<number>());
  const selected = p.targets.map(() => [] as number[]), gaps: number[] = [];
  const weekdays = p.targets.map(() => new Map<number, number>());
  let coverage = 0, special = 0, preferred = 0, weekdayCost = 0;
  assignment.forEach((e, i) => {
    const d = p.duties[i];
    if (d.lock !== undefined && d.lock !== e) throw Error('Missing lock');
    if (e === null) return;
    if (!Number.isInteger(e) || !d.eligible.includes(e)) throw Error('Ineligible/fractional assignment');
    used[e] += d.units;
    if (used[e] > p.targets[e]) throw Error('Target exceeded');
    if (d.weekend !== undefined) weekends[e].add(d.weekend);
    for (const b of p.boundaries ?? []) if (b.engineer === e && d.start <= b.end && b.start <= d.end) {
      const touching = d.start === b.end || d.end === b.start;
      if (!touching || d.lock !== e || !approvedBoundary(p, i, b)) throw Error('Boundary conflict');
    }
    const previous = selected[e].at(-1);
    if (previous !== undefined) {
      const gap = d.start - p.duties[previous].end;
      if (gap < 0 || (gap === 0 && !approvedPair(p, previous, i))) throw Error('Consecutive/overlapping duties');
      gaps.push(gap);
    }
    selected[e].push(i);
    coverage += d.days; special += d.special;
    if (d.weekday !== undefined) {
      weekdays[e].set(d.weekday, (weekdays[e].get(d.weekday) ?? 0) + 1);
      weekdayCost += p.weekdays?.[e][d.weekday] ?? 0;
    }
    preferred += p.preferences?.find(v => v.duty === i && v.engineer === e)?.weight ?? 0;
  });
  let rotation = 0, repeats = 0;
  for (let e = 0; e < used.length; e++) {
    if (weekends[e].size) rotation += p.rotation?.[e] ?? 0;
    for (const n of weekdays[e].values()) repeats += Math.max(0, n - 1);
    const approval = p.exceptions?.weekends?.find(a => a.engineer === e);
    if (approval ? [...weekends[e]].some(w => !approval.weekends.includes(w)) : weekends[e].size > 1) throw Error('Weekend cap exceeded');
    if (!selected[e].length) continue; // No external-anchor-to-anchor gap.
    const {before, after} = anchors(p, e);
    if (before) gaps.push(p.duties[selected[e][0]].start - before.end);
    if (after) gaps.push(after.start - p.duties[selected[e].at(-1)!].end);
  }
  return {coverage, special, units: used.reduce((a, b) => a + b, 0),
    deficits: used.map((n, e) => p.targets[e] - n), gaps: gaps.sort((a, b) => a - b), rotation, preferred, repeats, weekdays: weekdayCost};
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

/** Only absorb native endpoint noise; never round a fractional assignment. */
export function binaryValues(values: Record<string, number>) {
  return Object.fromEntries(Object.entries(values).map(([key, n]) => {
    if (!Number.isFinite(n) || Math.min(Math.abs(n), Math.abs(n - 1)) > 1e-8) throw Error('Non-binary solver value');
    return [key, Math.abs(n) <= 1e-8 ? 0 : 1];
  }));
}
const lexicographic = (av: number[], bv: number[]) => {
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    if ((av[i] ?? -Infinity) !== (bv[i] ?? -Infinity)) return (av[i] ?? -Infinity) < (bv[i] ?? -Infinity) ? -1 : 1;
  }
  return 0;
};
/** The quality levels above the seeded tie, lower is better: coverage, special, units,
 * minimum gap, weekend rotation, repeats, weekday rotation, preferred. */
export function compareQuality(a: Metrics, b: Metrics, spacing = true) {
  const head = (m: Metrics) => [-m.coverage, -m.special, -m.units, ...(spacing ? [-(m.gaps[0] ?? Infinity)] : []),
    m.rotation, m.repeats, m.weekdays, -m.preferred];
  return lexicographic(head(a), head(b));
}
/** The sorted-gap leximin below the seed; missing gaps pad with infinity. */
export function compareGaps(a: Metrics, b: Metrics) {
  return lexicographic(a.gaps.map(g => -g), b.gaps.map(g => -g));
}
/** Lexicographic objective order without the seed: quality, then the gap vector. */
export function compareMetrics(a: Metrics, b: Metrics, spacing = true) {
  return compareQuality(a, b, spacing) || (spacing ? compareGaps(a, b) : 0);
}
