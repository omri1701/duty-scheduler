'use client';
import {ChevronRight, LockKeyhole} from 'lucide-react';
import {Avatar} from '@/components/ui/avatar';
import {Chip} from '@/components/ui/chip';
import {addDays, type Duty, type State} from '@/lib/rota/engine';
import {shortDate} from '@/lib/date-format';
import type {Language, Translate} from './workspace-types';

/** Under the phone grid: the tapped day's duty as one row; tapping it opens the duty sheet. */
export function DayDetails({date, duty, state, lang, t, meId, onOpen, interactive}: {
  date: string; duty: Duty | undefined; state: State; lang: Language; t: Translate; meId: string; onOpen: (duty: Duty) => void; interactive: boolean;
}) {
  const a = duty ? state.assignments[duty.id] : undefined;
  const primary = state.team.find(p => p.id === a?.primary), cover = state.team.find(p => p.id === a?.secondary);
  const title = new Date(date + 'T12:00:00Z').toLocaleDateString(lang === 'en' ? 'en-GB' : 'he-IL', {weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC'});
  const last = duty ? addDays(duty.end, -1) : date;
  return <section className="day-details" aria-label={title} data-day-details>
    <h3 className="day-details-title">{title}{duty && last !== duty.start && <span className="muted"> – {shortDate(last, lang)}</span>}</h3>
    {duty ? <button type="button" className="row row-interactive day-duty" disabled={!interactive} onClick={() => onOpen(duty)}>
      <span className="row-lead">{primary ? <Avatar name={primary.name} color={primary.color} size={40}/> : <span className="avatar avatar-empty" aria-hidden="true">—</span>}</span>
      <span className="row-body">
        <span className="row-title">{primary ? <>{primary.name}{primary.id === meId && <span className="muted"> · {t('you', 'אני')}</span>}</> : t('Unassigned', 'ללא שיבוץ')}</span>
        <span className="row-subtitle">{duty.kind === 'special' ? (duty.title || t('Holiday', 'חג')) : duty.weekendId ? t('Weekend', 'סוף שבוע') : t('Weekday', 'יום חול')}{cover && ` · ${t('Cover', 'כיסוי')}: ${cover.name}`}</span>
      </span>
      <span className="row-trail"><Chip tone="neutral" size="sm">{duty.points} {t('pt', 'נק׳')}</Chip>{a?.locked && <LockKeyhole className="muted" size={16} aria-label={t('Locked', 'נעול')}/>}</span>
      {interactive && <ChevronRight className="row-chevron" aria-hidden="true"/>}
    </button> : <p className="muted small">{t('No duty on this day', 'אין כוננות ביום זה')}</p>}
  </section>;
}
