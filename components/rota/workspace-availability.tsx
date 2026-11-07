import {Lock} from 'lucide-react';
import {MonthTitle} from './month-title';
import {useMonthArrival} from './month-stage';
import {Select, SelectTrigger, SelectValue, SelectContent, SelectItem} from '@/components/ui/select';
import {Chip} from '@/components/ui/chip';
import {AvailabilityEditor} from '@/components/rota/availability-editor';
import type {State} from '@/lib/rota/engine';
import {shortDate} from '@/lib/date-format';
import type {Language, Translate} from './workspace-types';

/** The Availability tab (decision 2026-11-06): the month, who (admins), the grid. No legends. */
export function WorkspaceAvailability({state, month, monthLabel, onMonth, person, setPerson, dateCells, lang, isManager, meId, constraintsClosed, deadline, t, saveConstraints}: {
  state: State; month: string; monthLabel: string; onMonth: (offset: number) => void; person: string; setPerson: (id: string) => void; dateCells: string[]; lang: Language;
  isManager: boolean; meId: string; constraintsClosed: boolean; deadline: string; t: Translate;
  saveConstraints: (days: string[], kind: 'no' | 'prefer' | 'clear', note: string) => Promise<boolean>;
}) {
  const active = state.team.filter((p) => p.active);
  const mine = state.constraints[person] ?? {};
  const counts = Object.values(mine).reduce((n, kind) => ({...n, [kind]: (n[kind] ?? 0) + 1}), {} as Record<string, number>);
  // A name swipe refreshes the grid in place, blurred to sharp (owner round 4).
  const {ref: arrivalRef, mark: markArrival} = useMonthArrival<HTMLDivElement>(month);
  return <section className="availability-screen">
    <div className="month-bar">
      <MonthTitle month={month} label={monthLabel} t={t} onChange={onMonth} onSwipe={n => {markArrival(); onMonth(n);}}
        status={constraintsClosed ? <Chip tone="neutral" size="sm" className="month-status"><Lock/>{t('Closed', 'סגור')}</Chip> : <Chip tone="brand" size="sm" className="month-status">{t(`Due ${shortDate(deadline, lang)}`, `עד ${shortDate(deadline, lang)}`)}</Chip>}/>
      {isManager && <div className="month-actions">
        <Select value={person} onValueChange={setPerson}>
          <SelectTrigger aria-label={t('Engineer', 'מהנדס')} className="picker"><SelectValue/></SelectTrigger>
          <SelectContent>{active.map(p => <SelectItem value={p.id} key={p.id}>{p.name}{p.id === meId ? t(' (you)', ' (אני)') : ''}</SelectItem>)}</SelectContent>
        </Select>
      </div>}
    </div>
    <div className="availability-summary" aria-live="polite">
      <Chip tone="danger" size="sm"><i className="dot"/>{t(`${counts.no ?? 0} unavailable`, `${counts.no ?? 0} לא זמין`)}</Chip>
      <Chip tone="ok" size="sm"><i className="dot"/>{t(`${counts.prefer ?? 0} preferred`, `${counts.prefer ?? 0} מועדף`)}</Chip>
    </div>
    <div ref={arrivalRef}><AvailabilityEditor state={state} month={month} person={person} cells={dateCells} lang={lang} disabled={constraintsClosed} onSave={saveConstraints}/></div>
  </section>;
}
