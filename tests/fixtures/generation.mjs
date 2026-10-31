import {canonicalDuties, coverageStart} from '../../lib/scheduling/calendar.ts';

/** A real month with a known valid primary witness, not synthetic minute slots. */
export function monthScenario(kind = 'normal', count = 12) {
  const month = kind === 'weighted' ? '2027-12' : kind === 'dst' ? '2026-10' : kind === 'small-team' ? '2027-01' : '2026-11';
  if (kind === 'small-team') count = 2;
  const calendar = kind === 'weighted' ? {specials: [{id: 'holiday', start: '2027-12-30', end: '2028-01-02', extra: 2}],
    splitWeekends: ['2027-12-03', '2027-12-10'], specialDates: ['2027-12-12']} : {};
  const members = Array.from({length: count}, (_, i) => ({id: `e${String(i).padStart(2, '0')}`, active: true, approved: true, eligible: true}));
  const duties = canonicalDuties(month, calendar), usedWeekends = new Set(), witness = {};
  const targets = Object.fromEntries(members.map(m => [m.id, 0]));
  let cursor = 0, previous;
  for (const d of duties) {
    let selected;
    for (let k = 0; k < count; k++) {
      const id = members[(cursor + k) % count].id;
      if (id !== previous && (!d.weekendId || !usedWeekends.has(id))) {selected = id; cursor = (cursor + k + 1) % count; break;}
    }
    // Small teams intentionally have insufficient weekend capacity. Their
    // nominal confirmed targets still sum to all required duty points.
    selected ??= members[cursor++ % count].id;
    witness[d.id] = {primary: selected}; targets[selected] += d.units / 2;
    if (d.weekendId) usedWeekends.add(selected);
    previous = selected;
  }
  const input = {month, calendar, members, targets, sourceRevision: `fixture-${kind}-v1`, constraints: {}};
  if (kind === 'availability' || kind === 'weighted' || kind === 'tight') {
    for (const [e, m] of members.entries()) {
      input.constraints[m.id] = {};
      for (const [i, d] of duties.entries()) {
        if (witness[d.id].primary !== m.id && (i * 7 + e * 3) % 11 < (kind === 'tight' ? 9 : 3)) {
          for (const date of d.dates) input.constraints[m.id][date] = 'no';
        } else if ((i + e) % 9 === 0) input.constraints[m.id][d.startDate] = 'prefer';
      }
    }
  }
  if (kind === 'shared-shortage') {
    const constrained = members.slice(0, 2).map(m => m.id), slots = ['2026-11-01', '2026-11-05', '2026-11-09'];
    const before = constrained.reduce((sum, id) => sum + targets[id], 0);
    constrained.forEach(id => {targets[id] = 3;});
    targets[members.at(-1).id] += before - 6;
    for (const m of members) {
      input.constraints[m.id] = {};
      for (const d of duties) if (constrained.includes(m.id) !== slots.includes(d.id)) {
        for (const date of d.dates) input.constraints[m.id][date] = 'no';
      }
    }
  }
  if (kind === 'locked') input.locks = [duties[2], duties[8], duties[17]].map(d => ({dutyId: d.id, engineer: witness[d.id].primary}));
  // The witness gave the weekends to the first members; the rotation says they already had their turn.
  if (kind === 'rotation') input.weekendRotation = Object.fromEntries(members.slice(0, 4).map((m, i) => [m.id, i < 2 ? 2 : 1]));
  // Mid-cycle weekday state: every member has already covered two of the five weekdays.
  if (kind === 'weekday-rotation') input.weekdayRotation = Object.fromEntries(members.map((m, i) => [m.id, [0, 1, 2, 3, 4].map(wd => Number((wd + i) % 5 < 2))]));
  if (kind === 'boundary') {
    const id = members.find(m => m.id !== witness[duties[0].id].primary).id;
    input.neighbors = [
      {id: 'oct-live', ownerMonth: '2026-10', start: '2026-10-30', end: '2026-11-01', engineer: id, source: 'published'},
      {id: 'oct-working', ownerMonth: '2026-10', start: '2026-10-30', end: '2026-11-01', engineer: members[3].id, source: 'working'},
      {id: 'dec-working', ownerMonth: '2026-12', start: '2026-12-01', end: '2026-12-02',
        engineer: members.find(m => m.id !== witness[duties.at(-1).id].primary).id, source: 'working'},
    ];
  }
  return {input, witness, now: coverageStart(month, calendar) - 86400000};
}
