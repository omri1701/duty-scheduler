'use client';
import {useEffect, useRef, useState} from 'react';
import {LockKeyhole, Minus, Plus, RotateCcw, Sparkles} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Popover, PopoverAnchor, PopoverContent} from '@/components/ui/popover';
import {EditorDialog} from './editor-dialog';
import type {State} from '@/lib/rota/engine';
import type {AllocationWorkflow} from '@/hooks/use-allocation-workflow';
import type {Language, Translate} from './workspace-types';
import {nettedCompensation} from '@/lib/allocation/netting';

const points = (units: number) => String(units / 2);
const signed = (units: number) => `${units > 0 ? '+' : ''}${points(units)}`;

export function allocationMessage(message: string, t: Translate) {
  if (/This browser cannot|הדפדפן אינו/.test(message)) return message;
  if (/Ordinary baseline/.test(message)) return t('Keep the confirmed allocation and adjust Target or Permanent. The month weights and participating team have not changed.', 'יש לשמור על ההקצאה המאושרת ולערוך את היעד או השינוי הקבוע. משקלי החודש והצוות המשתתף לא השתנו.');
  if (/lineage|compound|ambiguous/.test(message)) return t('This month carries a published adjustment that needs review. Keep its original plan before changing transfers.', 'בחודש זה קיים שינוי שפורסם ודורש בדיקה. יש לשמור על התוכנית המקורית לפני שינוי העברות.');
  if (/target-total-mismatch|invalid-baseline-total/.test(message)) return t('Targets must add up to the required month total. Place the remaining points or undo.', 'סכום היעדים חייב להתאים לסך הנקודות לחודש. יש לחלק את הנקודות שנותרו או לבטל את השינוי.');
  if (/locked-points|lock.*target|target.*lock/.test(message)) return t('A target is below its locked points. Increase it or explicitly unlock duties.', 'יעד נמוך מהנקודות הנעולות. יש להגדיל אותו או לבטל נעילות במפורש.');
  if (/ineligible-lock|availability-approval/.test(message)) return t('A locked engineer is unavailable. Review the assignment in the calendar or unlock it.', 'המהנדס הנעול אינו זמין. יש לבדוק את השיבוץ בלוח או לבטל את הנעילה.');
  if (/consecutive|weekend|boundary|approval|fixed-/.test(message)) return t('Fixed duties conflict. Review or unlock the conflicting assignments in the calendar.', 'קיים קונפליקט בין תורנויות קבועות. יש לבדוק את השיבוצים המתנגשים בלוח או לבטל את נעילתם.');
  if (/generation-window-closed/.test(message)) return t('Coverage has started. Use manual assignments or swaps.', 'הכיסוי החודשי התחיל. יש לערוך שיבוצים ידנית או לבצע החלפות.');
  if (/stale|changed|revision|fingerprint/i.test(message)) return t('Team data changed. Refresh and review your retained targets before retrying.', 'נתוני הצוות השתנו. יש לרענן ולבדוק את היעדים שנשמרו לפני ניסיון נוסף.');
  if (/Worker|WASM|fetch|load failed/i.test(message)) return t('The planner could not start. Check your connection and retry in a current browser. Your saved draft is retained.', 'לא ניתן להפעיל את המתכנן. יש לבדוק את החיבור ולנסות שוב בדפדפן עדכני. הטיוטה השמורה נשמרה.');
  if (/repayment|source|allocation-members|target-members|offered|seniority/.test(message)) return t('This allocation needs a fresh review of team or compensation changes. Targets have been retained; request a new proposal explicitly if needed.', 'יש לבדוק שינויים בצוות או בפיצוי. היעדים נשמרו; ניתן לבקש הצעה חדשה במפורש.');
  return message;
}

export function AllocationDialog({flow: f, state, monthLabel, lang, t}: {
  flow: AllocationWorkflow; state: State; monthLabel: string; lang: Language; t: Translate;
}) {
  const name = (id: string) => state.team.find(p => p.id === id)?.name ?? t('Former engineer', 'מהנדס לשעבר');
  // Drag a member onto another to give one point. Long-press, right-click or a
  // keyboard action on the member opens the same choice as a list.
  const [dragging, setDragging] = useState<string | null>(null), [over, setOver] = useState<string | null>(null);
  const [giving, setGiving] = useState<string | null>(null);
  const press = useRef<{timer: ReturnType<typeof setTimeout>; x: number; y: number} | null>(null), toastRef = useRef<HTMLDivElement>(null);
  const endPress = () => {if (press.current) clearTimeout(press.current.timer); press.current = null;};
  // Touch screens long-press instead; a native touch drag would swallow the hold.
  const finePointer = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: fine)').matches;
  const canGive = (id: string) => {const r = f.totals?.rows.find(r => r.id === id); return !f.busy && !!r && r.target - 2 >= r.locked;};
  const give = (fromId: string, toId: string) => {setGiving(null); if (fromId !== toId && canGive(fromId)) void f.transfer(fromId, toId);};
  const {moved, dismissMoved} = f;
  useEffect(() => {
    if (!moved) return;
    const timer = setTimeout(() => {if (!toastRef.current?.contains(document.activeElement)) dismissMoved();}, 8000);
    return () => clearTimeout(timer);
  }, [moved, dismissMoved]);
  const owed = f.draft && f.captured ? nettedCompensation(f.captured.projected.net, f.draft, f.input?.seniority ?? []) : [];
  const pendingUnits = f.draft?.pending.reduce((n, p) => n + Math.abs(p.deltaUnits), 0) ?? 0;
  const status = f.phase === 'loading' ? t('Loading the authoritative month…', 'טוען את נתוני החודש…')
    : f.phase === 'confirming' ? t('Confirming targets…', 'מאשר את היעדים…')
    : f.phase === 'generating' ? t('Finding the best arrangement…', 'מחפש את השיבוץ הטוב ביותר…')
    : t('Verifying and saving your draft…', 'מאמת ושומר את הטיוטה…');
  return <EditorDialog open={f.open} onClose={f.close} saving={f.saving} lang={lang} className="allocation-dialog"
    title={t('Plan the month', 'תכנון החודש')} description={`${monthLabel} · ${t('Set the points. We’ll find the dates.', 'קובעים נקודות. המתכנן מוצא את התאריכים.')}`}>
    <div className="allocation-scroll">
      <div className="allocation-month-summary" aria-label={t('Monthly allocation total', 'סך ההקצאה החודשית')}>
        <div><span className="eyebrow">{t('MONTHLY POINTS', 'נקודות חודשיות')}</span><div className="allocation-total"><strong>{f.totals ? points(f.totals.configured) : '—'}</strong><span>/ {f.totals ? points(f.totals.total) : '—'}</span></div><p>{t('allocated / required', 'הוקצו / נדרשות')}</p></div>
        <div className="allocation-summary-detail"><LockKeyhole size={16}/><span>{f.totals ? points(f.totals.rows.reduce((n, r) => n + r.locked, 0)) : '—'} {t('locked points included', 'נקודות נעולות כלולות')}</span><small>{t('Primary duties only · emergency cover stays', 'תורנויות ראשיות בלבד · כיסוי החירום נשמר')}</small></div>
      </div>
      <div className="allocation-controls"><div className="allocation-step" role="group" aria-label={t('Point step', 'גודל צעד בנקודות')}><span>{t('Step', 'צעד')}</span>{[2, 1].map(step => <button key={step} aria-pressed={f.step === step} onClick={() => f.setStep(step)}>{points(step)}</button>)}</div><Button variant="ghost" size="sm" disabled={!f.history.length || f.saving} onClick={f.undo}><RotateCcw/>{t('Undo', 'ביטול שינוי')}</Button></div>
      {f.draft && <div className="allocation-table" role="table" aria-label={t('Monthly point allocation', 'הקצאת נקודות חודשית')}>
        <div className="allocation-table-head" role="row">{[t('Engineer', 'מהנדס'), t('Target', 'יעד'), t('Permanent', 'קבוע'), t('Locked', 'נעול'), t('Generate', 'לשיבוץ')].map(label => <span key={label} role="columnheader">{label}</span>)}</div>
        {f.totals?.rows.map((r, index) => <div className={`allocation-row${over === r.id ? ' drop-target' : ''}${dragging === r.id ? ' dragging' : ''}`} role="row" key={r.id} data-engineer={r.id}
          onDragOver={e => {if (dragging && dragging !== r.id) {e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOver(r.id);}}}
          onDragLeave={e => {if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(o => o === r.id ? null : o);}}
          onDrop={e => {e.preventDefault(); const from = dragging; setDragging(null); setOver(null); if (from) give(from, r.id);}}>
          <Popover open={giving === r.id} onOpenChange={open => {if (!open) setGiving(null);}}><PopoverAnchor asChild>
          <div className="allocation-engineer" role="rowheader" tabIndex={0} draggable={finePointer && canGive(r.id)} aria-haspopup="dialog" aria-expanded={giving === r.id}
            title={t('Drag onto another engineer to give 1 point', 'גוררים אל מהנדס אחר כדי להעביר נקודה אחת')}
            onDragStart={e => {e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', r.id); setDragging(r.id);}}
            onDragEnd={() => {setDragging(null); setOver(null);}}
            onKeyDown={e => {if (e.key === 'Enter' || e.key === ' ' || e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {e.preventDefault(); if (canGive(r.id)) setGiving(r.id);}}}
            onContextMenu={e => {e.preventDefault(); endPress(); if (canGive(r.id)) setGiving(r.id);}}
            onPointerDown={e => {if (e.pointerType === 'mouse') return; endPress(); press.current = {x: e.clientX, y: e.clientY, timer: setTimeout(() => {press.current = null; if (canGive(r.id)) setGiving(r.id);}, 500)};}}
            onPointerMove={e => {if (press.current && Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) > 10) endPress();}}
            onPointerUp={endPress} onPointerCancel={endPress}>
            <span className="allocation-rank">{String(index + 1).padStart(2, '0')}</span><span className="avatar small" style={{background: state.team.find(p => p.id === r.id)?.color}}>{name(r.id).split(' ').map(n => n[0]).join('').slice(0, 2)}</span><strong>{name(r.id)}</strong></div>
          </PopoverAnchor><PopoverContent className="allocation-give" align="start" dir={lang === 'he' ? 'rtl' : 'ltr'}
            onCloseAutoFocus={e => {e.preventDefault(); document.querySelector<HTMLElement>(`.allocation-row[data-engineer="${CSS.escape(r.id)}"] .allocation-engineer`)?.focus({preventScroll: true});}} aria-label={`${t('Give 1 point to…', 'העברת נקודה אחת אל…')} · ${name(r.id)}`}>
            <p>{t('Give 1 point to…', 'העברת נקודה אחת אל…')}</p>
            {f.totals?.rows.filter(o => o.id !== r.id).map(o => <button key={o.id} type="button" onClick={() => give(r.id, o.id)}>{name(o.id)}<bdi dir="ltr">{points(o.target)}</bdi></button>)}
          </PopoverContent></Popover>
          {(['temporary', 'permanent'] as const).map(kind => {
            const permanent = kind === 'permanent', label = permanent ? t('Permanent', 'קבוע') : t('Target', 'יעד');
            return <div className={`allocation-point-cell${permanent ? ' permanent' : ''}`} role="cell" key={kind}><span className="allocation-mobile-label">{label}</span><div className="allocation-stepper" aria-label={`${label} · ${name(r.id)}`}>
              <button disabled={f.busy || r.target - f.step < r.locked} aria-label={`${t('Decrease', 'הפחתת')} ${label} · ${name(r.id)}`} onClick={() => f.edit(r.id, -f.step, kind)}><Minus size={15}/></button>
              <output aria-live="polite" dir="ltr">{permanent ? signed(r.permanent) : points(r.target)}</output>
              <button disabled={f.busy} aria-label={`${t('Increase', 'הגדלת')} ${label} · ${name(r.id)}`} onClick={() => f.edit(r.id, f.step, kind)}><Plus size={15}/></button>
            </div></div>;
          })}
          <div className="allocation-readout" role="cell"><span className="allocation-mobile-label">{t('Locked', 'נעול')}</span><LockKeyhole size={12}/><bdi>{points(r.locked)}</bdi></div>
          <div className="allocation-readout generate" role="cell"><span className="allocation-mobile-label">{t('Generate', 'לשיבוץ')}</span><bdi>{points(r.generate)}</bdi></div>
          {f.ceilings && r.target > f.ceilings[r.id] && <p className="allocation-row-warning" role="note">{t(`Availability allows about ${points(f.ceilings[r.id])}`, `הזמינות מאפשרת בערך ${points(f.ceilings[r.id])}`)}</p>}
        </div>)}
      </div>}
      <p className="allocation-caption">{t('Target includes Permanent. Generate is Target minus Locked; it may require a partial schedule.', 'היעד כולל את השינוי הקבוע. לשיבוץ = יעד פחות נעול; ייתכן שיתקבל שיבוץ חלקי.')}</p>
      {f.draft && <details className="allocation-details" open={!!f.draft.pending.length}>
        <summary>{t('Adjustments & compensation', 'שינויים ופיצוי')}{!!owed.length && <span>{owed.length}</span>}</summary>
        {pendingUnits > 0 && <p className="allocation-attention">{points(pendingUnits)} {t('pts still need a counterpart', 'נק׳ עדיין דורשות הקצאה נגדית')}</p>}
        {owed.length ? <ul>{owed.map(l => <li key={`${l.debtorId}>${l.creditorId}`}><strong>{name(l.debtorId)} {lang === 'he' ? '←' : '→'} {name(l.creditorId)}</strong> · <bdi>{points(l.units)}</bdi> · {[
          l.thisMonth && `${points(l.thisMonth)} ${t('this month', 'החודש')}`, l.later && `${points(l.later)} ${t('later', 'בהמשך')}`].filter(Boolean).join(' · ')}</li>)}</ul>
          : <p>{t('No one owes points.', 'אין נקודות פתוחות.')}</p>}
      </details>}
      {f.closed && <div className="warning-note">{t('Monthly coverage has started. Generation is closed; manual changes, locks and swaps remain available.', 'הכיסוי החודשי התחיל. השיבוץ האוטומטי נסגר; ניתן לערוך ידנית, לנעול ולהחליף תורנויות.')}</div>}
      {(f.structural || f.error) && <div className="warning-note" role="alert">{allocationMessage(f.structural || f.error, t)}</div>}
      {f.notice && <p className="allocation-caption" role="status">{f.notice}</p>}
      {moved && <div className="allocation-toast" role="status" ref={toastRef}><span>{t(`${name(moved.toId)} took 1 point from ${name(moved.fromId)}`, `נקודה אחת הועברה מ־${name(moved.fromId)} אל ${name(moved.toId)}`)} · {t('temporary', 'זמני')}</span><button type="button" disabled={f.busy} onClick={f.makePermanent}>{t('Make permanent', 'להפוך לקבוע')}</button></div>}
      {f.busy && <div className="allocation-progress" role="status"><Sparkles className="spin" size={18}/><div><strong>{status}</strong>{f.progress !== null && <p>{f.progress} {t('dates covered so far', 'תאריכים מכוסים עד כה')}</p>}<small>{t('Your saved assignments stay in place until a verified draft is saved.', 'השיבוצים השמורים נשארים עד לשמירת טיוטה מאומתת.')}</small></div></div>}
      <div className="allocation-secondary-actions"><Button variant="ghost" size="sm" disabled={f.busy} onClick={f.refreshReview}>{t('Refresh & review retained targets', 'רענון ובדיקת היעדים שנשמרו')}</Button><Button variant="ghost" size="sm" disabled={f.busy || f.closed || !f.input} onClick={f.propose}>{t('Use a new proposal', 'שימוש בהצעה חדשה')}</Button>{!f.closed && <Button variant="ghost" size="sm" disabled={!f.canConfirm} onClick={() => f.confirm(false)}>{t('Save allocation only', 'שמירת ההקצאה בלבד')}</Button>}</div>
    </div>
    <div className="allocation-footer"><div><strong>{f.totals ? `${points(f.totals.configured)} / ${points(f.totals.total)}` : '—'} {t('pts', 'נק׳')}</strong><small>{t('Confirm targets · save as draft', 'אישור יעדים · שמירה כטיוטה')}</small></div>{f.phase === 'generating' ? <Button variant="outline" onClick={f.cancel}>{t('Cancel', 'ביטול')}</Button> : <Button disabled={!f.canConfirm || (!f.closed && !f.captured?.generationAllowed)} onClick={() => f.confirm(!f.closed)}><Sparkles/>{f.closed ? t('Save allocation', 'שמירת ההקצאה') : t('Confirm & generate', 'אישור ושיבוץ')}</Button>}</div>
  </EditorDialog>;
}
