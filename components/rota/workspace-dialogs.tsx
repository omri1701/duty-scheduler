import {CheckCircle2} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Checkbox} from '@/components/ui/checkbox';
import {Sheet} from '@/components/ui/sheet';
import {Avatar} from '@/components/ui/avatar';
import {Chip} from '@/components/ui/chip';
import {addDays, monthNext, type State, type Duty} from '@/lib/rota/engine';
import type {WorkspaceDraft} from '@/hooks/use-workspace-draft';
import type {Language, Translate, FormatDate} from './workspace-types';
type DialogCopy = {lang: Language; t: Translate};

export function CancelDraftDialog({open, onOpenChange, saving, lang, t, monthLabel, onConfirm}: DialogCopy & {
  open: boolean; onOpenChange: (open: boolean) => void; saving: boolean; monthLabel: string; onConfirm: () => Promise<void>;
}) {
  return <Sheet open={open} onOpenChange={value => {if (!saving) onOpenChange(value);}} lang={lang} kind="alert" role="alertdialog" closeDisabled={saving} busy={saving}
    title={t('Cancel draft?', 'לבטל את הטיוטה?')} description={`${monthLabel} · ${t('Unpublished changes are discarded; the published schedule comes back.', 'שינויים שלא פורסמו יימחקו; הלוח שפורסם יחזור.')}`}
    onOpenAutoFocus={event => {event.preventDefault(); document.getElementById('keep-draft')?.focus();}}
    footer={<div className="sheet-actions"><Button id="keep-draft" variant="secondary" disabled={saving} onClick={() => onOpenChange(false)}>{t('Keep draft', 'שמירת הטיוטה')}</Button><Button variant="destructive" disabled={saving} onClick={onConfirm}>{t('Discard draft', 'ביטול הטיוטה')}</Button></div>}>
    <span className="sr-only">{monthLabel}</span>
  </Sheet>;
}

export function ClearBoardDialog({open, onOpenChange, saving, lang, t, monthLabel, count, onConfirm}: DialogCopy & {
  open: boolean; onOpenChange: (open: boolean) => void; saving: boolean; monthLabel: string; count: number; onConfirm: () => Promise<void>;
}) {
  return <Sheet open={open} onOpenChange={value => {if (!saving) onOpenChange(value);}} lang={lang} kind="alert" role="alertdialog" closeDisabled={saving} busy={saving}
    title={count === 1 ? t('Clear 1 unlocked duty?', 'לנקות תורנות אחת שאינה נעולה?') : t(`Clear ${count} unlocked duties?`, `לנקות ${count} תורנויות שאינן נעולות?`)}
    description={`${monthLabel} · ${t('Locked duties, constraints, special blocks and the plan stay.', 'תורנויות נעולות, אילוצים, מקטעים מיוחדים והתוכנית נשארים.')}`}
    onOpenAutoFocus={event => {event.preventDefault(); document.getElementById('keep-board')?.focus();}}
    footer={<div className="sheet-actions"><Button id="keep-board" variant="secondary" disabled={saving} onClick={() => onOpenChange(false)}>{t('Cancel', 'ביטול')}</Button><Button className="danger-action" variant="destructive" disabled={saving || !count} onClick={onConfirm}>{t('Clear board', 'ניקוי הלוח')}</Button></div>}>
    <span className="sr-only">{monthLabel}</span>
  </Sheet>;
}

export function DraftSwapDialog({controller, state, duties, lang, t, fmt, nickname, personName}: DialogCopy & {
  controller: WorkspaceDraft['swap']; state: State; duties: Duty[]; fmt: FormatDate; nickname: (id?: string) => string; personName: (id?: string) => string;
}) {
  const {selection: swap, setSelection: setSwap, override: swapOverride, setOverride: setSwapOverride, preview: swapPreview, reason: swapReason, confirm: confirmSwap, saving} = controller;
  const member = (id?: string) => state.team.find(p => p.id === id);
  const conflicts = !!(swapPreview?.conflicts?.length || swapPreview?.weekendConflicts?.length || swapPreview?.noWeekendConflicts?.length);
  return <Sheet open={!!swap} onOpenChange={(v) => !v && !saving && setSwap(null)} lang={lang} closeDisabled={saving} busy={saving}
    title={t('Swap duties', 'החלפת תורנויות')} description={t('Emergency cover stays on its dates.', 'כיסוי החירום נשאר בתאריכים שלו.')}
    footer={<div className="sheet-actions"><Button variant="secondary" disabled={saving} onClick={() => setSwap(null)}>{t('Cancel', 'ביטול')}</Button><Button disabled={saving || !swapPreview?.ok} onClick={confirmSwap}>{t('Confirm swap', 'אישור החלפה')}</Button></div>}>
    {swap && <>
      <div className="swap-review">
        {[swap.from, swap.to].map((id, i) => {
          const b = duties.find((b) => b.id === id), other = i === 0 ? swap.to : swap.from;
          const from = member(state.assignments[id]?.primary), to = member(state.assignments[other]?.primary);
          return <div key={id} className="card card-inset"><div className="row">
            <span className="row-lead"><Avatar name={to?.name ?? '?'} color={to?.color} size={36}/></span>
            <span className="row-body"><span className="row-title">{fmt(id)}{b && b.end !== addDays(id, 1) ? ` – ${fmt(addDays(b.end, -1))}` : ''}</span>
              <span className="row-subtitle">{nickname(from?.id)} → <b>{nickname(to?.id)}</b></span></span>
            <span className="row-trail"><Chip tone="neutral" size="sm">{b?.points} {t('pt', 'נק׳')}</Chip></span>
          </div></div>;
        })}
      </div>
      {swapPreview && !swapPreview.ok && !conflicts && <p className="note-line" data-tone="danger">{swapReason(swapPreview.reason)}</p>}
      {conflicts && <div className="note-line" style={{display: 'block'}}>
        {!!swapPreview?.conflicts?.length && <p>{t('Availability conflicts: ', 'התנגשות עם אילוצים: ')}{swapPreview.conflicts.map((c) => `${personName(c.person)} · ${fmt(c.date)}${state.constraintNotes?.[c.person]?.[c.date] ? ' · ' + state.constraintNotes[c.person][c.date] : ''}`).join(' / ')}</p>}
        {swapPreview?.weekendConflicts?.map(c => {
          const monthLabel = new Intl.DateTimeFormat(lang === 'he' ? 'he-IL' : 'en-GB', {month: 'long', timeZone: 'UTC'}).format(new Date(c.month + '-01T12:00:00Z'));
          return <p key={c.person}>{t(`This swap gives ${personName(c.person)} ${c.count} weekends in ${monthLabel}. Approve exception?`, `ההחלפה נותנת ל${personName(c.person)} ${c.count} סופי שבוע בחודש ${monthLabel}. לאשר חריגה?`)}</p>;
        })}
        {swapPreview?.noWeekendConflicts?.map(c => <p key={`${c.person}${c.date}`}>{t(`${personName(c.person)} doesn’t take weekends · ${fmt(c.date)}`, `${personName(c.person)} לא עושה סופי שבוע · ${fmt(c.date)}`)}</p>)}
        <label className="check-label manager-override"><Checkbox disabled={saving} checked={swapOverride} onCheckedChange={(v) => setSwapOverride(!!v)}/>{t('Approve these exceptions as manager', 'אישור החריגות כמנהל')}</label>
      </div>}
    </>}
  </Sheet>;
}

export function SpecialDutyDialog({form, month, lang, t, fmt}: DialogCopy & {form: WorkspaceDraft['special']; month: string; fmt: FormatDate}) {
  const {open: specialOpen, setOpen: setSpecialOpen, title: specialTitle, setTitle: setSpecialTitle, start: specialStart, setStart: setSpecialStart, end: specialEnd, setEnd: setSpecialEnd, extra, setExtra, add: addSpecial} = form;
  return <Sheet open={specialOpen} onOpenChange={setSpecialOpen} lang={lang} title={t('Special block', 'מקטע מיוחד')} description={t('Each date is its own duty with the extra points; a weekend in the range stays one duty.', 'כל תאריך הוא תורנות משלו עם התוספת; סוף שבוע בטווח נשאר תורנות אחת.')}
    footer={<div className="sheet-actions"><Button onClick={addSpecial}>{t('Add special block', 'הוספת מקטע מיוחד')}</Button></div>}>
    <label className="field-label">{t('Name', 'שם')}<input maxLength={60} value={specialTitle} onChange={(e) => setSpecialTitle(e.target.value)} placeholder={t('e.g. Holiday coverage', 'למשל: כיסוי חג')}/></label>
    <div className="form-pair">
      <label className="field-label">{t('First day', 'יום ראשון')}<input type="date" value={specialStart} min={month + '-01'} max={addDays(monthNext(month) + '-01', -1)} onChange={(e) => {setSpecialStart(e.target.value); if (specialEnd < e.target.value) setSpecialEnd(e.target.value);}}/></label>
      <label className="field-label">{t('Last day', 'יום אחרון')}<input type="date" min={specialStart} value={specialEnd} onChange={(e) => setSpecialEnd(e.target.value)}/></label>
    </div>
    <label className="field-label">{t('Extra points per day', 'נקודות נוספות לכל יום')}<input type="number" min="0" max="20" step="0.5" value={extra} onChange={(e) => setExtra(e.target.value)}/></label>
    <div className="special-summary">
      <strong>{1 + Number(extra) || 1} {t('points per weekday', 'נקודות לכל יום חול')}</strong>
      <span>{t('Friday and Saturday: ½ + extra each.', 'שישי ושבת: ½ + תוספת לכל יום.')}</span>
      <span>{specialStart && specialEnd && `${fmt(specialStart)} 09:00 → ${fmt(addDays(specialEnd, 1))} 09:00`}</span>
    </div>
  </Sheet>;
}

export function MonthSettingsDialog({settings, setSettings, monthLabel, monthDetails, lang, t, onDeadline}: DialogCopy & {
  settings: boolean; setSettings: (open: boolean) => void; monthLabel: string; monthDetails: State['months'][string]; onDeadline: (deadline: string) => void;
}) {
  return <Sheet open={settings} onOpenChange={setSettings} lang={lang} kind="alert" title={t('Constraints deadline', 'מועד אחרון לאילוצים')} description={`${monthLabel} · ${t('Members enter constraints until this day (Israel time).', 'חברי הצוות מזינים אילוצים עד יום זה (שעון ישראל).')}`}
    footer={<div className="sheet-actions"><Button onClick={() => setSettings(false)}>{t('Done', 'סיום')}</Button></div>}>
    <label className="field-label">{t('Deadline', 'מועד אחרון')}<input type="date" value={monthDetails.deadline} onChange={(e) => {if (e.target.value) onDeadline(e.target.value);}}/></label>
  </Sheet>;
}

export function PublishDialog({publishOpen, setPublishOpen, monthLabel, assigned, saving, lang, t, onPublish}: DialogCopy & {
  publishOpen: boolean; setPublishOpen: (open: boolean) => void; monthLabel: string; assigned: number; saving: boolean; onPublish: () => Promise<void>;
}) {
  return <Sheet open={publishOpen} onOpenChange={setPublishOpen} lang={lang} kind="alert" closeDisabled={saving} busy={saving} title={t('Publish?', 'לפרסם?')} description={`${monthLabel} · ${assigned} ${t('duties covered', 'תורנויות משובצות')}`}
    footer={<div className="sheet-actions"><Button variant="secondary" disabled={saving} onClick={() => setPublishOpen(false)}>{t('Not yet', 'עוד לא')}</Button><Button disabled={saving} onClick={onPublish}>{t('Publish', 'פרסום')}</Button></div>}>
    <div className="publish-summary"><CheckCircle2 size={28}/><p>{t('The team sees it and gets notified. You can reopen it any time.', 'הצוות יראה אותו ויקבל התראה. אפשר לפתוח לעריכה בכל עת.')}</p></div>
  </Sheet>;
}
