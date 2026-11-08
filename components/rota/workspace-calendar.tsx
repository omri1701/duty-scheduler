import {CalendarDateLine, CalendarSurface, CalendarDay, CalendarAssignment} from './calendar-presentation';
import {calendarCells} from '@/lib/rota/calendar-dates';
import {streakCells} from '@/lib/rota/streaks';
import {ArrowLeftRight, LockKeyhole} from 'lucide-react';
import {addDays, dayOf, ownerMonth, type State, type Duty} from '@/lib/rota/engine';
import {memberStyle} from '@/lib/theme/palette';
import type {CalendarInteractions} from '@/hooks/use-calendar-interactions';
import type {Language, Translate, FormatDate} from './workspace-types';
import {useLayoutEffect, useRef, type ReactNode} from 'react';
import {useMobileLayout} from '@/hooks/use-mobile-layout';

/** The month grid (decision 2026-11-06): names in member colours, the member's own duties
 * highlighted, today ringed; a tap goes to `onSelect`, a hold-and-drag proposes a swap. */
export function WorkspaceCalendar({state, calendarState, calendarBlocks, dateCells, today, month, lang, t, fmt, nickname, meId, readOnly, requesting, interactions, onSelect, selectedDay, pickingFrom, notices, flashDays, preview = false}: {
  state: State; calendarState: State; calendarBlocks: Duty[]; dateCells: string[]; today: string; month: string; lang: Language; t: Translate; fmt: FormatDate;
  nickname: (id?: string) => string; meId: string; readOnly: boolean; requesting: boolean; interactions: CalendarInteractions;
  /** A tap or Enter on a day that isn't part of a swap in progress. */
  onSelect: (duty: Duty, date: string) => void;
  /** The day whose details show under the phone grid. */
  selectedDay?: string | null;
  /** An admin's draft swap waiting for its second duty. */
  pickingFrom?: string | null;
  notices?: ReactNode;
  /** Days pointed at from elsewhere (the plan's split-weekend notice): they pulse once. */
  flashDays?: readonly string[];
  /** The neighbouring month sliding in (month-stage.tsx): the same grid, without the gesture surface. */
  preview?: boolean;
}) {
  const {keyboardSource, dragFrom, dragOver, pendingDrop, swapSourceDays, publishedDuty, requestTarget, swapHint, swapBlock, dragContainer, ignoreDragClick, selectCalendarDuty} = interactions;
  const mobile = useMobileLayout();
  // Display only: adjacent duties of one member read as a single bar; a split weekend's halves
  // stay two regular day chips (decision 2026-11-07).
  const streaks = streakCells(calendarBlocks, calendarState.assignments, (a, b) => !!a.weekendId && a.weekendId === b.weekendId);
  const cells = calendarCells(dateCells, calendarBlocks), draft = calendarState.months[month]?.status === 'draft';
  const locked = (b?: Duty) => !!b && draft && !!calendarState.assignments[b.id]?.locked;
  // A week with a lock or a +extra gives the phone a marks line under its dates, in every cell so the bars stay level.
  const week = (date: string) => addDays(date, -dayOf(date));
  const markedWeeks = new Set(cells.filter(c => locked(c.period) || (c.period && streaks[c.period.id]?.badge !== undefined)).map(c => week(c.date)));
  const picking = !!(keyboardSource || pickingFrom);
  // A refresh keeps the grid on screen and fades in only the chips whose person changed; a new
  // month or the first paint animates nothing (it already looked like this while sliding in).
  const seen = useRef<{month: string; people: Record<string, string>} | null>(null);
  useLayoutEffect(() => {
    if (preview) return;
    const people = Object.fromEntries(calendarBlocks.map(b => [b.id, calendarState.assignments[b.id]?.primary ?? '']));
    const before = seen.current;
    seen.current = {month, people};
    if (!before || before.month !== month || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    for (const [id, person] of Object.entries(people)) if (id in before.people && before.people[id] !== person)
      document.querySelector(`.month-pane:not(.month-peek) [data-gesture-key="${CSS.escape(id)}"] .assignment-chip`)?.animate([{opacity: 0, transform: 'scale(.96)'}, {opacity: 1, transform: 'none'}], {duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)'});
  });
  return <CalendarSurface lang={lang} dir={mobile && lang === 'he' ? 'rtl' : 'ltr'} gridRef={preview ? undefined : dragContainer} gridClassName={'gesture-grid' + (picking ? ' picking' : '')} notices={notices}>
    <span id="published-swap-help" className="sr-only" aria-live="polite">
      {requesting ? keyboardSource ? t('Choose the duty to swap with. Greyed days say why. Escape cancels.', 'בחרו את הכוננות להחלפה. ימים אפורים מסבירים למה. Escape לביטול.') : '' : pickingFrom ? t('Choose the duty to swap with. Escape cancels.', 'בחרו את הכוננות להחלפה. Escape לביטול.') : ''}
    </span>
    {cells.map(({date: d, period: b, combined}) => {
      const a = b ? calendarState.assignments[b.id] : undefined,
        p = state.team.find(p => p.id === a?.primary),
        mine = a?.primary === meId || a?.secondary === meId,
        interactive = !!b && ownerMonth(b) === month,
        cell = b ? streaks[b.id] : undefined;
      // While a swap is chosen, a day the server would refuse is greyed with its reason.
      const swapFrom = requesting ? keyboardSource ?? dragFrom ?? pendingDrop?.from ?? null : null,
        blocked = swapFrom && b && interactive && b.id !== swapFrom ? swapHint(swapFrom, b.id) : null,
        swapState = swapFrom && b && interactive && b.id !== swapFrom ? swapBlock(swapFrom, b.id) : undefined;
      const source = !!b && (dragFrom === b.id || keyboardSource === b.id || pickingFrom === b.id || pendingDrop?.from === b.id);
      const name = p ? nickname(p.id) : '', long = name.length > 7;
      const initials = p ? p.name.trim().split(/\s+/).map(n => n[0] ?? '').join('').slice(0, 2) : '';
      const label = (showYou: boolean) => <span className="pill-text" data-long={long || undefined}>
        <span className="pill-name">{name}</span>{long && <span className="pill-initials" aria-hidden="true">{initials}</span>}
        {showYou && p?.id === meId && <small> {t('(you)', '(אני)')}</small>}
      </span>;
      return (
        <CalendarDay date={d} month={month} combined={combined} weekend={!!b?.weekendId} special={b?.kind === 'special'}
          disabled={readOnly || !interactive || (requesting && !!keyboardSource && !publishedDuty(b!.id) && !blocked)}
          aria-disabled={blocked ? true : undefined}
          title={blocked ?? undefined}
          data-swap-state={swapState === undefined ? undefined : swapState === 'pending' ? 'pending' : swapState ? 'blocked' : 'ok'}
          key={d}
          data-gesture-key={interactive ? b?.id : undefined}
          onClick={() => {
            if (!interactive || ignoreDragClick() || !b) return;
            // A swap in progress takes the tap; otherwise the caller decides (day details or the duty sheet).
            if (keyboardSource) {selectCalendarDuty(b); return;}
            onSelect(b, d);
          }}
          onKeyDown={(e) => {if (e.key === 'Escape') interactions.cancelKeyboard();}}
          aria-pressed={requesting && keyboardSource === b?.id}
          aria-describedby={picking ? 'published-swap-help' : undefined}
          style={p ? memberStyle(p.color) : undefined}
          className={[
            !interactive ? 'adjacent-duty' : '',
            mine ? 'mine' : '',
            d === today ? 'today' : '',
            selectedDay === d ? 'selected-day' : '',
            flashDays?.includes(d) ? 'flash-day' : '',
            cell ? `streak-${cell.position}` : '',
            cell?.breakBefore ? 'streak-break-before' : '',
            cell?.breakAfter ? 'streak-break-after' : '',
            cell?.nameColumns ? 'streak-label-cell' : '',
            markedWeeks.has(week(d)) ? 'marks-week' : '',
            combined && b?.specialDates?.includes(b.start) ? 'holiday-friday' : '',
            combined && b?.specialDates?.includes(addDays(b!.start, 1)) ? 'holiday-saturday' : '',
            source ? 'drag-source' : '',
            (dragOver === b?.id && dragFrom !== b?.id && !(swapState && swapState !== 'pending')) || (keyboardSource && b && requestTarget(keyboardSource, b.id)) || pendingDrop?.to === b?.id ? 'drag-target' : '',
            pendingDrop?.to === b?.id || (dragOver === b?.id && swapState === 'pending') ? 'checking' : '',
            (requesting ? b && swapSourceDays.has(b.id) : draft && a?.primary) ? 'can-swap' : '',
            blocked ? 'swap-blocked' : '',
          ].join(' ')}
          aria-label={`${b && swapSourceDays.has(b.id) && requesting ? t('Request swap: ', 'בקשת החלפה: ') : ''}${fmt(d)}${combined ? ' – ' + fmt(addDays(b!.end, -1)) : ''} ${p?.name ?? t('Unassigned', 'ללא שיבוץ')}${blocked ? ` · ${t('Unavailable', 'לא זמין')}: ${blocked}` : ''}`}
        >
          <CalendarDateLine today={today} date={d} end={combined ? addDays(b!.end, -1) : undefined}>
            {source && <span className="swap-source-mark" role="img" aria-label={t('Swapping this duty', 'מחליפים את הכוננות הזאת')}><ArrowLeftRight/></span>}
            {locked(b) && <span className="duty-lock-indicator" role="img" aria-label={t('Locked duty', 'כוננות נעולה')}><LockKeyhole size={11}/></span>}
            {cell?.badge !== undefined && <span className="tiny-badge" dir="ltr">+{cell.badge}</span>}
          </CalendarDateLine>
          {b && (p || interactive) && <>
            <CalendarAssignment className={(p ? 'member-tint' : 'empty-assignment') + (mine ? ' mine-chip' : '')}>
              {p ? cell?.nameColumns ? <>
                {/* The name centres across its whole row segment; the placeholder keeps this chip as tall as the rest of the bar. */}
                <span className="streak-continued" aria-hidden="true"/>
                <span className="streak-label" style={{'--streak-span': cell.nameColumns / (combined ? 2 : 1)} as React.CSSProperties}>{label(true)}</span>
              </> : cell?.showName === false ? <span className="streak-continued" aria-hidden="true"/> : label(true)
              : <span className="pill-text">{draft ? t('Open', 'פנוי') : '—'}</span>}
            </CalendarAssignment>
            {b.title && cell?.showTitle !== false && <div className="special-title">{b.title}</div>}
            {a?.secondary && <div className="secondary-name"><bdi dir="ltr">+ {nickname(a.secondary)}</bdi></div>}
          </>}
        </CalendarDay>
      );
    })}
  </CalendarSurface>;
}
