import {
  addDays,
  dayOf,
  monthNext,
  dates,
  totals,
  allKnownBlocks,
  unavailable,
  ownerMonth,
  normalizeWeekends,
  overlap,
  type State,
  type Duty,
} from './engine.ts';

// Workspace projections: scheduling rules remain in the React-free engine.
export function workspaceMetrics(state: State, month: string, duties: Duty[]) {
  const owned = duties.filter((b) => ownerMonth(b) === month),
    active = state.team.filter((p) => p.active),
    monthTotals = totals(state, owned),
    historyTotals = totals(state, allKnownBlocks(state));
  const assigned = duties.filter((b) => state.assignments[b.id]?.primary).length;
  const conflicts = duties.filter((b) => {
    const a = state.assignments[b.id];
    return (
      a &&
      [a.primary, a.secondary].some((id) => id && unavailable(b, id, state.constraints).length) &&
      !a.override
    );
  });
  const gaps = active.flatMap((p) => {
    const mine = owned.filter(
      (b) =>
        state.assignments[b.id]?.primary === p.id || state.assignments[b.id]?.secondary === p.id,
    );
    return mine
      .filter(
        (b, i) =>
          i > 0 &&
          b.start === mine[i - 1].end &&
          (!b.weekendId || b.weekendId !== mine[i - 1].weekendId) &&
          (b.start.slice(0, 7) === month || mine[i - 1].start.slice(0, 7) === month),
      )
      .map((b) => ({ p, b }));
  });

  return { owned, active, monthTotals, historyTotals, assigned, conflicts, gaps };
}
export type WorkspaceMetrics = ReturnType<typeof workspaceMetrics>;

export function calendarDates(month: string) {
  const dateCells = dates(
    addDays(month + '-01', -dayOf(month + '-01')),
    addDays(monthNext(month) + '-01', (7 - dayOf(monthNext(month) + '-01')) % 7),
  );
  return dateCells;
}

// A draft edit can also touch a carried weekend or special range in another month.
export function prepareWorkspaceUpdate(
  s: State,
  changed: State,
  month: string,
  monthDetails: State['months'][string],
  draft = true,
) {
  const n = normalizeWeekends(changed);
  if (draft) {
    const months = {
      ...n.months,
      [month]: { ...(n.months[month] ?? monthDetails), status: 'draft' as const },
    };
    const specialsChanged = JSON.stringify(s.specials) !== JSON.stringify(n.specials);
    for (const b of [...allKnownBlocks(s), ...allKnownBlocks(n)]) {
      const changed =
        JSON.stringify(s.assignments[b.id]) !== JSON.stringify(n.assignments[b.id]) ||
        specialsChanged;
      if (changed)
        for (const m of Object.keys(months))
          if (overlap(b, { start: m + '-01', end: monthNext(m) + '-01' }))
            months[m] = { ...months[m], status: 'draft' };
    }
    n.months = months;
  }
  return n;
}
