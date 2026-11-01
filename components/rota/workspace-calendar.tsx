import {CalendarDateLine, CalendarSurface, CalendarDay, CalendarAssignment, CalendarFilters} from './calendar-presentation';
import {calendarCells} from '@/lib/rota/calendar-dates';
import {streakCells} from '@/lib/rota/streaks';
import type { CSSProperties } from 'react';
import { Plus, Info, LockKeyhole, Eraser } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { addDays, dayOf, ink, ownerMonth, type State, type Duty } from '@/lib/rota/engine';
import type { WorkspaceMetrics } from '@/lib/rota/workspace-data';
import type { CalendarInteractions } from '@/hooks/use-calendar-interactions';
import type { Language, Translate, FormatDate } from './workspace-types';

export function WorkspaceCalendar({
  state,
  calendarState,
  calendarBlocks,
  dateCells,
  today,
  month,
  monthDetails,
  lang,
  t,
  fmt,
  nickname,
  meId,
  isManager,
  readOnly,
  requesting,
  publication,
  view,
  setView,
  reopened,
  viewingDraft,
  setVersion,
  onSpecial,
  clearCount = 0,
  onClearBoard,
  metrics,
  interactions,
  blockCount,
}: {
  state: State;
  calendarState: State;
  calendarBlocks: Duty[];
  dateCells: string[];
  today: string;
  month: string;
  monthDetails: State['months'][string];
  lang: Language;
  t: Translate;
  fmt: FormatDate;
  nickname: (id?: string) => string;
  meId: string;
  isManager: boolean;
  readOnly: boolean;
  requesting: boolean;
  publication: string | null | undefined;
  view: string;
  setView: (view: string) => void;
  reopened: boolean;
  viewingDraft: boolean;
  setVersion: (version: string) => void;
  onSpecial: () => void;
  /** Unlocked duties Clear board would remove from this draft. */
  clearCount?: number;
  onClearBoard?: () => void;
  metrics: WorkspaceMetrics;
  interactions: CalendarInteractions;
  blockCount: number;
}) {
  const { assigned, conflicts, gaps } = metrics;
  const {
    keyboardSource,
    dragFrom,
    dragOver,
    ownPublishedDays,
    publishedDuty,
    requestTarget,
    dragContainer,
    ignoreDragClick,
    selectCalendarDuty,
  } = interactions;
  // Display only: adjacent duties of one member read as a single bar.
  const streaks = streakCells(calendarBlocks, calendarState.assignments);
  const cells = calendarCells(dateCells, calendarBlocks), draft = calendarState.months[month]?.status === 'draft';
  const locked = (b?: Duty) => !!b && draft && !!calendarState.assignments[b.id]?.locked;
  // A week with a lock or a +extra gives the phone a marks line under its dates, in every cell so the bars stay level.
  const week = (date: string) => addDays(date, -dayOf(date));
  const markedWeeks = new Set(cells.filter(c => locked(c.period) || (c.period && streaks[c.period.id]?.badge !== undefined)).map(c => week(c.date)));
  return (
    <CalendarSurface lang={lang} gridRef={dragContainer} gridClassName="gesture-grid" toolbar={<>
        {reopened ? <>
          <div className="segmented" role="group" aria-label={t('Schedule version', '\u05d2\u05e8\u05e1\u05ea \u05dc\u05d5\u05d7')}>
            {(['draft', 'published'] as const).map(version => <button key={version} aria-pressed={viewingDraft === (version === 'draft')} className={viewingDraft === (version === 'draft') ? 'selected' : ''} onClick={() => setVersion(version)}>{version === 'draft' ? t('Draft', '\u05d8\u05d9\u05d5\u05d8\u05d4') : t('Published', '\u05e4\u05d5\u05e8\u05e1\u05dd')}</button>)}
          </div>
          <button className="my-duties-toggle" aria-pressed={view === 'me'} onClick={() => setView(view === 'me' ? 'team' : 'me')}>{t('My duties', '\u05d4\u05ea\u05d5\u05e8\u05e0\u05d5\u05d9\u05d5\u05ea \u05e9\u05dc\u05d9')}</button>
        </> : (isManager || !!publication) && <CalendarFilters t={t} value={view} onChange={setView}/>}
        {/* Draft tools wrap together. Clear board is a fresh start for the draft only; the published version is never cleared. */}
        <div className="calendar-draft-tools" style={{ display: viewingDraft ? undefined : 'none' }}>
          {viewingDraft && onClearBoard && <Button variant="ghost" disabled={readOnly || !clearCount} onClick={onClearBoard}>
            <Eraser />
            {t('Clear board', 'ניקוי הלוח')}
          </Button>}
          <Button variant="ghost" onClick={onSpecial} disabled={readOnly}>
            <Plus />
            {t('Special block', 'מקטע מיוחד')}
          </Button>
        </div>
      </>} beforeGrid={!isManager && monthDetails.status !== 'published' && (
        <div className="inline-note">
          {t('The manager has not published this month yet.', 'המנהל עדיין לא פרסם את החודש הזה.')}
        </div>
      )}
      footer={<>
        <span>
          <span className="legend-box" />
          {t('Weekend = 1 point · Split = ½ each', 'סופ״ש = נקודה · חצי לכל יום בפיצול')}
        </span>
        <span>
          <span className="legend-box special-legend" />
          {t('Special block', 'מקטע מיוחד')}
        </span>
        <span id="published-swap-help" aria-live="polite">
          {requesting
            ? keyboardSource
              ? t(
                  'Choose another engineer’s duty · Escape cancels',
                  'בחרו תורנות של מהנדס אחר · Escape לביטול',
                )
              : t(
                  'Drag your duty · On mobile, hold first · Or select two dates',
                  'גררו תורנות שלכם · בנייד, לחצו ארוכות תחילה · או בחרו שני תאריכים',
                )
            : t('Tap to edit · Hold & drag to swap', 'לחצו לעריכה · לחיצה ארוכה וגרירה להחלפה')}
        </span>
      </>} notices={<>

      {isManager && assigned < blockCount && (
        <div className="inline-note">
          <Info size={17} />
          {monthDetails.generated
            ? t(
                'Uncovered dates need a decision. Open a date to see candidates and override a constraint if necessary.',
                'תאריכים ללא כיסוי דורשים החלטה. פתחו יום לצפייה במועמדים וחריגה מאילוץ במידת הצורך.',
              )
            : t(
                'Ready when you are. Generate a draft using the team’s availability.',
                'כשתהיו מוכנים, צרו טיוטה לפי אילוצי הצוות.',
              )}
        </div>
      )}
      {!!conflicts.length && (
        <div className="warning-note">
          {t(
            `${conflicts.length} assignments conflict with availability. Review them before publishing.`,
            'קיימות התנגשויות עם אילוצים. יש לבדוק אותן לפני פרסום.',
          )}
        </div>
      )}
      {!!gaps.length && (
        <div className="inline-note">
          {t('Spacing to review:', 'מרווחים לבדיקה:')}{' '}
          {gaps
            .slice(0, 3)
            .map(({ p, b }) => `${p.name} · ${fmt(b.start)}`)
            .join(' / ')}{' '}
          — {t('consecutive duties are allowed when needed.', 'תורנויות רצופות מותרות בעת הצורך.')}
        </div>
      )}
      </>}>
        {cells.map(({date:d, period:b, combined}) => {
          const a = b ? calendarState.assignments[b.id] : undefined,
            p = state.team.find((p) => p.id === a?.primary),
            mine = a?.primary === meId || a?.secondary === meId,
            interactive = !!b && ownerMonth(b) === month,
            cell = b ? streaks[b.id] : undefined;
          return (
            <CalendarDay date={d} month={month} combined={combined} weekend={!!b?.weekendId} special={b?.kind==='special'}
              disabled={readOnly || !interactive || (requesting && !publishedDuty(b!.id))}
              key={d}
              data-gesture-key={interactive ? b?.id : undefined}
              onClick={() => {
                if (interactive && !ignoreDragClick() && b) selectCalendarDuty(b);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  interactions.cancelKeyboard();
                }
              }}
              aria-pressed={requesting && keyboardSource === b?.id}
              aria-describedby={requesting ? 'published-swap-help' : undefined}
              className={[
                !interactive ? 'adjacent-duty' : '',
                cell ? `streak-${cell.position}` : '',
                cell?.breakBefore ? 'streak-break-before' : '',
                cell?.breakAfter ? 'streak-break-after' : '',
                cell?.nameColumns ? 'streak-label-cell' : '',
                markedWeeks.has(week(d)) ? 'marks-week' : '',
                // A holiday marks only its own dates inside a combined weekend.
                combined && b?.specialDates?.includes(b.start) ? 'holiday-friday' : '',
                combined && b?.specialDates?.includes(addDays(b!.start, 1)) ? 'holiday-saturday' : '',
                view === 'me' && !mine ? 'faded' : '',
                dragFrom === b?.id || keyboardSource === b?.id ? 'drag-source' : '',
                (dragOver === b?.id && dragFrom !== b?.id) ||
                (keyboardSource && b && requestTarget(keyboardSource, b.id))
                  ? 'drag-target'
                  : '',
                (
                  requesting
                    ? b && ownPublishedDays.has(b.id)
                    : monthDetails.status === 'draft' && a?.primary
                )
                  ? 'can-swap'
                  : '',
              ].join(' ')}
              aria-label={`${b && ownPublishedDays.has(b.id) && requesting ? t('Request swap: ', 'בקשת החלפה: ') : ''}${fmt(d)}${combined ? ' – ' + fmt(addDays(b!.end, -1)) : ''} ${p?.name ?? t('Unassigned', 'ללא שיבוץ')}`}
            >
              <CalendarDateLine today={today} date={d} end={combined ? addDays(b!.end,-1) : undefined}>
                {locked(b) && <span className="duty-lock-indicator" role="img" aria-label={t('Locked duty', 'תורנות נעולה')}><LockKeyhole size={12}/></span>}
                {cell?.badge !== undefined && <span className="tiny-badge">+{cell.badge}</span>}
              </CalendarDateLine>
              {b && (
                <>
                  <CalendarAssignment
                    className={!p ? 'empty-assignment' : ''}
                    style={
                      p
                        ? {
                            borderInlineStartColor: p.color,
                            background: p.color,
                            color: ink(p.color),
                            '--chip-color': p.color,
                          } as CSSProperties
                        : undefined
                    }
                  >
                    {p ? cell?.nameColumns ? (
                      <>
                        {/* The name centres across its whole row segment; the placeholder keeps this chip as tall as the rest of the bar. */}
                        <span className="streak-continued" aria-hidden="true" />
                        <span className="streak-label" style={{ '--streak-span': cell.nameColumns / (combined ? 2 : 1) } as CSSProperties}>
                          {nickname(p.id)}
                          {p.id === meId && <small> {t('(you)', '(אני)')}</small>}
                        </span>
                      </>
                    ) : cell?.showName === false ? (
                      <span className="streak-continued" aria-hidden="true" />
                    ) : (
                      <span>
                        {nickname(p.id)}
                        {p.id === meId && <small> {t('(you)', '(אני)')}</small>}
                      </span>
                    ) : (
                      <span>{t('Unassigned', 'ללא שיבוץ')}</span>
                    )}
                  </CalendarAssignment>
                  {b.title && cell?.showTitle !== false && <div className="special-title">{b.title}</div>}
                  {a?.secondary && <div className="secondary-name">+ {nickname(a.secondary)}</div>}

                </>
              )}
            </CalendarDay>
          );
        })}
      </CalendarSurface>
  );
}
