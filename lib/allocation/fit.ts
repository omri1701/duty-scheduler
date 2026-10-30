/** Largest search accepted in the browser. Real months need far fewer steps; a
 * pathological calendar reports 'allocation-fit-limit' instead of freezing. */
export const FIT_STEP_LIMIT = 1_000_000;

/** `cost` is exact below the caller's budget; otherwise it is only a lower bound. */
type Split = {cost: number; shares: number[]; exact: boolean};

const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;

/** The plain equal split at the duty quantum, ascending: remainders to the last
 * (newest) shares. It is the cheapest possible, if the duties allow it. */
export function equalShares(weights: readonly number[], n: number) {
  const total = weights.reduce((a, b) => a + b, 0), q = weights.reduce(gcd, 0) || 1;
  const share = Math.floor(total / (n * q)) * q, left = (total - share * n) / q;
  return [...Array(n - left).fill(share), ...Array(left).fill(share + q)] as number[];
}

/** The ordinary baseline is an exact, minimum-squared-cost partition of the
 * indivisible canonical duty weights (duty_private.allocation_baseline). Return
 * that partition's shares, ascending. The equal split is used whenever it is a
 * real partition; otherwise an exact search picks the cheapest one. No solver. */
export function fitPartition(weights: readonly number[], n: number, limit = FIT_STEP_LIMIT): number[] {
  const total = weights.reduce((a, b) => a + b, 0), q = weights.reduce(gcd, 0) || 1;
  if (!Number.isInteger(n) || n < 1 || !Number.isSafeInteger(total * total * n)) throw Error('allocation-fit-limit');
  // Cost of the equal split of `sum` into m shares: a lower bound for any real split.
  const balanced = (m: number, sum: number) => {
    const share = Math.floor(sum / (m * q)) * q, left = (sum - share * m) / q;
    return (m - left) * share * share + left * (share + q) ** 2;
  };
  const floor = balanced(n, total), equal = equalShares(weights, n);
  // Fast path: largest duty into the lightest share.
  const greedy = Array(n).fill(0);
  for (const w of [...weights].sort((a, b) => b - a)) {greedy.sort((a, b) => a - b); greedy[0] += w;}
  if (greedy.sort((a, b) => a - b).join() === equal.join()) return equal;
  // Moving duty w from share A to share B lowers the cost whenever A - B > w, so
  // every optimum lies within the largest weight of the average.
  const values = [...new Set(weights)].sort((a, b) => b - a), counts = values.map(v => weights.filter(w => w === v).length);
  const spread = n * values[0], low = Math.max(0, Math.ceil((total - spread) / n)), high = Math.floor((total + spread) / n);
  const memo = new Map<string, Split>();
  let steps = 0;
  const step = () => {if (++steps > limit) throw Error('allocation-fit-limit');};
  const none = (cost: number): Split => ({cost, shares: [], exact: false});
  // Cheapest split of the remaining duty counts into m shares below `budget`.
  // Equal remainders are one state; the share holding the largest remaining duty is chosen next.
  const best = (m: number, rest: number[], sum: number, budget: number): Split => {
    if (sum < m * low || sum > m * high) return {cost: Infinity, shares: [], exact: true};
    if (m === 1 || sum === 0) return {cost: sum * sum, shares: [sum, ...Array(m - 1).fill(0)], exact: true};
    const key = m + ':' + rest.join(), known = memo.get(key);
    if (known && (known.exact || known.cost >= budget)) return known;
    const first = rest.findIndex(r => r > 0), options: {part: number; take: number[]}[] = [], take = rest.map(() => 0);
    const choose = (t: number, part: number) => {
      step();
      if (part > high) return;
      if (t === values.length) {if (part >= low) options.push({part, take: [...take]}); return;}
      for (let k = t === first ? 1 : 0; k <= rest[t]; k++) {take[t] = k; choose(t + 1, part + k * values[t]);}
      take[t] = 0;
    };
    choose(0, 0);
    // Nearest the average first, so the bound prunes early.
    options.sort((a, b) => Math.abs(m * a.part - sum) - Math.abs(m * b.part - sum) || b.part - a.part);
    let found = none(budget);
    const target = balanced(m, sum);
    for (const {part, take} of options) {
      step();
      if (part * part + balanced(m - 1, sum - part) >= found.cost) continue;
      const other = best(m - 1, rest.map((r, i) => r - take[i]), sum - part, found.cost - part * part);
      if (other.exact && part * part + other.cost < found.cost) found = {cost: part * part + other.cost, shares: [part, ...other.shares], exact: true};
      if (found.exact && found.cost === target) break;
    }
    memo.set(key, found);
    return found;
  };
  const result = best(n, counts, total, greedy.reduce((s, x) => s + x * x, 0) + 1);
  if (!result.exact || result.cost === Infinity || result.cost < floor) throw Error('allocation-fit-limit');
  return result.shares.sort((a, b) => a - b);
}
