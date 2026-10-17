import {CalendarDateLine, CalendarSurface, CalendarDay, CalendarAssignment, CalendarFilters} from './calendar-presentation';
import {calendarCells} from '@/lib/rota/calendar-dates';
import { Plus, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { addDays, ink, type State, type Duty } from '@/lib/rota/engine';
import type { WorkspaceMetrics } from '@/lib/rota/workspace-data';
import type { CalendarInteractions } from '@/hooks/use-calendar-interactions';
import type { Language, Translate, FormatDate } from './workspace-types';

export function WorkspaceCalendar({
  state,
  calendarState,
  calendarBlocks,
  dateCells,
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
  onSpecial,
  metrics,
  interactions,
  blockCount,
}: {
  state: State;
  calendarState: State;
  calendarBlocks: Duty[];
  dateCells: string[];
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
  onSpecial: () => void;
  metrics: WorkspaceMetrics;
  interactions: CalendarInteractions;
  blockCount: number;
}) {
  const { assigned, conflicts, gaps } = metrics;
  const {
    keyboardSource,
    setKeyboardSource,
    dragFrom,
    dragOver,
    ownPublishedDays,
    publishedDuty,
    requestTarget,
    dragContainer,
    ignoreDragClick,
    selectCalendarDuty,
  } = interactions;
  return (
    <CalendarSurface lang={lang} gridRef={dragContainer} gridClassName="gesture-grid" toolbar={<>
        <CalendarFilters t={t} value={view} onChange={next=>{setView(next);setKeyboardSource(null)}}>
          {isManager && publication && (
            <button
              className={view === 'published' ? 'selected' : ''}
              onClick={() => {
                setView('published');
                setKeyboardSource(null);
              }}
            >
              {t('Published', '\u05e4\u05d5\u05e8\u05e1\u05dd')}
            </button>
          )}
        </CalendarFilters>
        <Button
          style={{ display: isManager && !requesting ? undefined : 'none' }}
          variant="ghost"
          onClick={() => {
            onSpecial();
          }}
          disabled={readOnly}
        >
          <Plus />
          {t('Special block', 'מקטע מיוחד')}
        </Button>
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
        {calendarCells(dateCells, calendarBlocks).map(({date:d, period:b, combined}) => {
          const a = b ? calendarState.assignments[b.id] : undefined,
            p = state.team.find((p) => p.id === a?.primary),
            mine = a?.primary === meId || a?.secondary === meId;
          return (
            <CalendarDay date={d} month={month} combined={combined} weekend={!!b?.weekendId} special={b?.kind==='special'}
              disabled={readOnly || !b || (requesting && !publishedDuty(b.id))}
              key={d}
              data-gesture-key={b?.id}
              onClick={() => {
                if (!ignoreDragClick() && b) selectCalendarDuty(b);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  interactions.cancelKeyboard();
                }
              }}
              aria-pressed={requesting && keyboardSource === b?.id}
              aria-describedby={requesting ? 'published-swap-help' : undefined}
              className={[
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
              <CalendarDateLine date={d} end={combined ? addDays(b!.end,-1) : undefined}>
                {b?.kind === 'special' && (
                  <span className="tiny-badge">+{b.points - (b.weekendId ? 0.5 : 1)}</span>
                )}
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
                          }
                        : undefined
                    }
                  >
                    {p ? (
                      <span>
                        {nickname(p.id)}
                        {p.id === meId && <small> {t('(you)', '(אני)')}</small>}
                      </span>
                    ) : (
                      <span>{t('Unassigned', 'ללא שיבוץ')}</span>
                    )}
                  </CalendarAssignment>
                  {b.title && <div className="special-title">{b.title}</div>}
                  {a?.secondary && <div className="secondary-name">+ {nickname(a.secondary)}</div>}
                  {ownPublishedDays.has(b.id) && requesting && (
                    <small className="request-swap-hint">{t('Request swap', 'בקשת החלפה')}</small>
                  )}
                </>
              )}
            </CalendarDay>
          );
        })}
      </CalendarSurface>
  );
}
