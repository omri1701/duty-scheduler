'use client';
import {ArrowLeftRight, LockKeyhole, PenLine} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Sheet} from '@/components/ui/sheet';
import {Avatar} from '@/components/ui/avatar';
import {Chip} from '@/components/ui/chip';
import {ListRow} from '@/components/ui/list-row';
import {addDays, type Duty, type State} from '@/lib/rota/engine';
import {shortDate} from '@/lib/date-format';
import type {Language, Translate} from './workspace-types';

export type DutySheetActions = {
  /** Starts choosing the duty to swap with; absent when this duty can't be swapped (with the reason). */
  swap?: {onClick: () => void; reason?: string};
  /** Opens the editor; absent for members, present but disabled with a reason when an admin can't edit now. */
  edit?: {onClick: () => void; reason?: string};
};

/** What a tapped duty shows (decision 2026-11-06): the facts, then Swap and, for admins, Edit. */
export function DutySheet({duty, state, lang, t, meId, open, onClose, actions, published}: {
  duty: Duty | null; state: State; lang: Language; t: Translate; meId: string; open: boolean; onClose: () => void; actions: DutySheetActions; published: boolean;
}) {
  const b = duty;
  const a = b ? state.assignments[b.id] : undefined;
  const member = (id?: string) => state.team.find(p => p.id === id);
  const primary = member(a?.primary), cover = member(a?.secondary);
  const last = b ? addDays(b.end, -1) : '';
  const range = b ? (last === b.start ? shortDate(b.start, lang) : `${shortDate(b.start, lang)} – ${shortDate(last, lang)}`) : '';
  const kind = !b ? '' : b.kind === 'special' ? (b.title || t('Holiday', 'חג')) : b.weekendId ? t('Weekend', 'סוף שבוע') : t('Weekday', 'יום חול');
  const weekday = b ? new Date(b.start + 'T12:00:00Z').toLocaleDateString(lang === 'en' ? 'en-GB' : 'he-IL', {weekday: 'long', timeZone: 'UTC'}) : '';
  return <Sheet open={open && !!b} onOpenChange={next => {if (!next) onClose();}} lang={lang} title={range} description={`${weekday} · ${kind}`} className="duty-sheet"
    onCloseAutoFocus={event => {event.preventDefault(); if (b) document.querySelector<HTMLButtonElement>(`[data-gesture-key="${b.id}"]`)?.focus({preventScroll: true});}}
    footer={(actions.swap || actions.edit) && <div className="sheet-actions">
      {actions.swap && <Button className="grow" disabled={!!actions.swap.reason} title={actions.swap.reason} onClick={actions.swap.onClick}><ArrowLeftRight/>{t('Swap', 'החלפה')}</Button>}
      {actions.edit && <Button className="grow" variant={actions.swap ? 'secondary' : 'default'} disabled={!!actions.edit.reason} title={actions.edit.reason} onClick={actions.edit.onClick}><PenLine/>{t('Edit', 'עריכה')}</Button>}
    </div>}>
    {b && <div className="duty-facts">
      <div className="duty-chips">
        <Chip tone="brand">{b.points === 1 ? t('1 point', 'נקודה אחת') : t(`${b.points} points`, `${b.points} נקודות`)}</Chip>
        {published ? <Chip tone="ok">{t('Published', 'פורסם')}</Chip> : <Chip tone="neutral">{t('Draft', 'טיוטה')}</Chip>}
        {a?.locked && <Chip tone="neutral"><LockKeyhole/>{t('Locked', 'נעול')}</Chip>}
        {a?.override && <Chip tone="warn">{t('Admin exception', 'חריגת מנהל')}</Chip>}
      </div>
      <div className="card card-inset">
        <ListRow lead={primary ? <Avatar name={primary.name} color={primary.color} size={36}/> : <span className="avatar avatar-empty" aria-hidden="true">—</span>}
          title={primary ? <>{primary.name}{primary.id === meId && <span className="muted"> · {t('you', 'אני')}</span>}</> : t('Unassigned', 'ללא שיבוץ')} subtitle={t('On duty', 'תורן/ית')}/>
        {cover && <ListRow lead={<Avatar name={cover.name} color={cover.color} size={36}/>} title={<>{cover.name}{cover.id === meId && <span className="muted"> · {t('you', 'אני')}</span>}</>} subtitle={t('Emergency cover', 'כיסוי חירום')}/>}
      </div>
      {actions.swap?.reason && <p className="muted small">{actions.swap.reason}</p>}
    </div>}
  </Sheet>;
}
