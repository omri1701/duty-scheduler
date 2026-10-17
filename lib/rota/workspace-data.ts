import {
  blocks,
  totals,
  allKnownBlocks,
  unavailable,
  ownerMonth,
  normalizeWeekends,
  type State,
  type Duty,
} from './engine.ts';
import {calendarDates} from './calendar-dates.ts';

// Workspace projections: scheduling rules remain in the React-free engine.
export function workspaceMetrics(state: State, month: string, duties: Duty[]) {
  const owned = duties.filter((b) => ownerMonth(b) === month),
    active = state.team.filter((p) => p.active),
    monthTotals = totals(state, owned),
    historyTotals = totals(state, allKnownBlocks(state));
  const assigned = owned.filter((b) => state.assignments[b.id]?.primary).length;
  const conflicts = owned.filter((b) => {
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

export {calendarDates} from './calendar-dates.ts';

// Populate every visible date, keeping combined weekends as one period.
export function visibleCalendarBlocks(state: State, month: string) {
  const months = new Set(calendarDates(month).map(day => day.slice(0, 7)));
  const duties = new Map<string, Duty>();
  for (const m of months) for (const b of blocks(m, state.specials, state.splitWeekends)) duties.set(b.id, b);
  return [...duties.values()];
}

export function prepareWorkspaceUpdate(s: State, changed: State, month: string, monthDetails: State['months'][string], draft = true) {
  // Normalization must not merge a different month's independent split weekend.
  const n = normalizeWeekends({...changed, splitWeekends: changed.splitWeekends?.filter(f => f.startsWith(month))});
  n.splitWeekends = [...(changed.splitWeekends ?? []).filter(f => !f.startsWith(month)), ...(n.splitWeekends ?? [])];
  if (draft) {
    const before = new Map(allKnownBlocks(s).map(b => [b.id, b]));
    const after = new Map(allKnownBlocks(n).map(b => [b.id, b]));
    for (const [id, b] of new Map([...before, ...after])) {
      const changedDuty = JSON.stringify(s.assignments[id]) !== JSON.stringify(n.assignments[id]) ||
        JSON.stringify(before.get(id)) !== JSON.stringify(after.get(id));
      if (changedDuty && ownerMonth(b) !== month) throw Error('Edit duties in their owning month.');
    }
    n.months = {...n.months, [month]: {...(n.months[month] ?? monthDetails), status: 'draft'}};
  }
  return n;
}
