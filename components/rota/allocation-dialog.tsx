'use client';
import {useEffect, useRef, useState, type CSSProperties} from 'react';
import {Check, LockKeyhole, Minus, Plus, RotateCcw, RotateCw, Save, Sparkles} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Popover, PopoverAnchor, PopoverContent} from '@/components/ui/popover';
import {EditorDialog} from './editor-dialog';
import {PlanPie} from './plan-pie';
import './plan-month.css';
import type {State} from '@/lib/rota/engine';
import type {AllocationWorkflow} from '@/hooks/use-allocation-workflow';
import type {Kind} from '@/lib/allocation/types';
import type {Language, Translate} from './workspace-types';
import {nettedCompensation} from '@/lib/allocation/netting';
import {loneHalf} from '@/lib/compensation';
import {shortDate} from '@/lib/date-format';
import {userMessage} from '@/lib/messages';

const points = (units: number) => String(units / 2);
const signed = (units: number) => `${units > 0 ? '+' : '−'}${points(Math.abs(units))}`;

/** Every error the plan shows names its reason (lib/messages.ts). */
export const allocationMessage = userMessage;

export function AllocationDialog({flow: f, state, monthLabel, lang, t}: {
  flow: AllocationWorkflow; state: State; monthLabel: string; lang: Language; t: Translate;
}) {
  const member = (id: string) => state.team.find(p => p.id === id);
  const name = (id: string) => member(id)?.name ?? t('Former engineer', 'מהנדס לשעבר');
  // One kind for every +/− control: most changes are temporary (repaid later).
  const [kind, setKind] = useState<Kind>('temporary');
  // The member highlighted in the pie, from a slice or from that member's row.
  const [active, setActive] = useState<string | null>(null);
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
  // Making a dragged point permanent adds it to the receiver's permanent change.
  const receiver = moved && f.totals?.rows.find(r => r.id === moved.toId);
  const canMakePermanent = !!receiver && receiver.permanent + 2 <= receiver.permanentMax;
  useEffect(() => {
    if (!moved) return;
    const timer = setTimeout(() => {if (!toastRef.current?.contains(document.activeElement)) dismissMoved();}, 8000);
    return () => clearTimeout(timer);
  }, [moved, dismissMoved]);
  // Built from the compiled plan: what is really repaid now and carried forward.
  const owed = f.planned?.plan && f.captured ? nettedCompensation(f.captured.projected.net, {transfers: f.planned.plan.intents, repayments: f.planned.plan.repayments}, f.input?.seniority ?? []) : [];
  // One line per extra share: "Avi and Dana get 6 pts".
  const list = (ids: string[]) => new Intl.ListFormat(lang === 'he' ? 'he' : 'en', {type: 'conjunction'}).format(ids.map(name));
  const uneven = [...new Set(f.uneven.map(u => u.units))].sort((a, b) => b - a).map(units => {
    const ids = f.uneven.filter(u => u.units === units).map(u => u.id);
    return t(`${list(ids)} ${ids.length > 1 ? 'get' : 'gets'} ${points(units)} pts`, `${list(ids)} – ${points(units)} נק׳`);
  }).join('; ');
  const unplacedUnits = Math.abs(f.unplaced.temporary) + Math.abs(f.unplaced.permanent);
  const status = f.phase === 'loading' ? t('Loading the authoritative month…', 'טוען את נתוני החודש…')
    : f.phase === 'confirming' ? t('Confirming targets…', 'מאשר את היעדים…')
    : f.phase === 'generating' ? t('Finding the best arrangement…', 'מחפש את השיבוץ הטוב ביותר…')
    : t('Verifying and saving your draft…', 'מאמת ושומר את הטיוטה…');
  const kindLabel = kind === 'permanent' ? t('Permanent', 'קבוע') : t('Temporary', 'זמני');
  const rows = f.draft ? f.totals?.rows ?? [] : [];
  const slices = rows.map(r => ({...r, name: name(r.id), color: member(r.id)?.color ?? '#c8d3c4'}));
  return <EditorDialog open={f.open} onClose={f.close} saving={f.saving} lang={lang} className="allocation-dialog"
    title={t('Plan the month', 'תכנון החודש')} description={`${monthLabel} · ${t('Set the points. We’ll find the dates.', 'קובעים נקודות. המתכנן מוצא את התאריכים.')}`}>
    <div className="allocation-scroll">
      <section className="plan-hero" aria-label={t('Monthly allocation total', 'סך ההקצאה החודשית')}>
        <PlanPie slices={slices} configured={f.totals?.configured ?? 0} total={f.totals?.total ?? 0} active={active} onActive={setActive} rtl={lang === 'he'} t={t}/>
        <div className="plan-hero-side">
          <p className="plan-hint">{t('Each slice is one person’s points. Point at a slice or a person for details.', 'כל פרוסה היא הנקודות של אדם אחד. מצביעים על פרוסה או על אדם כדי לראות פרטים.')}</p>
          <div className="plan-kind" role="group" aria-label={t('Change type for + and −', 'סוג השינוי ב־+ ו־−')}>
            {(['temporary', 'permanent'] as const).map(k => <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>
              <strong>{k === 'permanent' ? t('Permanent', 'קבוע') : t('Temporary', 'זמני')}</strong>
              <small>{k === 'permanent' ? t('no repayment', 'ללא החזר') : t('repaid later', 'יוחזר בהמשך')}</small>
            </button>)}
          </div>
          <div className="plan-tools">
            <div className="allocation-step" role="group" aria-label={t('Point step', 'גודל צעד בנקודות')}><span>{t('Step', 'צעד')}</span>{[2, 1].map(step => <button key={step} type="button" aria-pressed={f.step === step} onClick={() => f.setStep(step)}>{points(step)}</button>)}</div>
            <Button variant="ghost" size="sm" disabled={!f.history.length || f.saving} onClick={f.undo}><RotateCcw/>{t('Undo', 'ביטול שינוי')}</Button>
          </div>
        </div>
      </section>
      {/* After Generate the plan is the review: uncovered dates and an unfinished search, in one line each. */}
      {f.outcome?.generated && !!f.totals?.uncovered.length && <p className="allocation-attention" role="note">{t('Uncovered: ', 'ללא כיסוי: ')}{f.totals.uncovered.map(d => shortDate(d, lang)).join(' · ')}</p>}
      {f.outcome?.generated && f.result && !f.result.search.allStagesProved && <p className="allocation-attention" role="note">{t('Best found; search limit reached.', 'התוצאה הטובה שנמצאה; מגבלת החיפוש הושגה.')}</p>}
      {f.replanBlocked && <p className="allocation-attention" role="note">{allocationMessage(f.replanBlocked, t)}</p>}
      {!f.divisible && <p className="allocation-attention" role="note">{t('Generate will leave a gap: this month’s duties can’t make these exact points. Change by whole points or undo, or fill the gap by hand after Generate.', 'השיבוץ ישאיר פער: תורנויות החודש אינן יכולות להרכיב בדיוק את הנקודות האלה. אפשר לשנות בנקודות שלמות או לבטל, או למלא את הפער ידנית אחרי השיבוץ.')}</p>}
      {uneven && <p className="allocation-attention" role="note">{t('This month’s duties can’t split evenly: ', 'תורנויות החודש אינן מתחלקות שווה בשווה: ')}{uneven}.</p>}
      <p className="plan-sr" id="plan-no-counterpart">{t('No one else can take on less. Drag a point instead.', 'אין מי שיכול לקבל פחות. אפשר לגרור נקודה במקום.')}</p>
      <p className="plan-sr" id="plan-no-receiver">{t('No one else can take this point. Drag a point instead.', 'אין מי שיכול לקבל את הנקודה. אפשר לגרור נקודה במקום.')}</p>
      {f.draft && <div className="plan-rows" role="table" aria-label={t('Monthly point allocation', 'הקצאת נקודות חודשית')}>
        <div className="plan-sr" role="row"><span role="columnheader">{t('Engineer', 'מהנדס')}</span><span role="columnheader">{t('Points', 'נקודות')}</span></div>
        {rows.map(r => {
          const permanent = kind === 'permanent';
          // Floors: points never below locked; a permanent reduction never beyond the member's own share.
          const floor = r.target - f.step < r.locked || (permanent && r.permanent - f.step < r.permanentMin);
          // Ceiling: fair share plus a permanent punishment never exceeds the month's total points.
          const ceiling = permanent && r.permanent + f.step > r.permanentMax, capNote = `plan-cap-${r.id}`;
          // The library's own verdict: a + no one else can absorb (or past a floor or ceiling) is disabled.
          const allowed = f.options?.[r.id]?.[kind], up = !ceiling && (allowed?.up ?? !f.replanBlocked), down = !floor && (allowed?.down ?? !f.replanBlocked);
          return <div className={`plan-row${active === r.id ? ' active' : ''}${over === r.id ? ' drop-target' : ''}${dragging === r.id ? ' dragging' : ''}`} role="row" key={r.id} data-engineer={r.id}
            style={{'--member': member(r.id)?.color ?? '#c8d3c4'} as CSSProperties}
            onPointerEnter={e => {if (e.pointerType === 'mouse') setActive(r.id);}} onPointerLeave={e => {if (e.pointerType === 'mouse') setActive(a => a === r.id ? null : a);}}
            onFocus={() => setActive(r.id)} onBlur={e => {if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setActive(a => a === r.id ? null : a);}}
            onDragOver={e => {if (dragging && dragging !== r.id) {e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOver(r.id);}}}
            onDragLeave={e => {if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(o => o === r.id ? null : o);}}
            onDrop={e => {e.preventDefault(); const from = dragging; setDragging(null); setOver(null); if (from) give(from, r.id);}}>
            <Popover open={giving === r.id} onOpenChange={open => {if (!open) setGiving(null);}}><PopoverAnchor asChild>
            <div className="plan-member" role="rowheader" tabIndex={0} draggable={finePointer && canGive(r.id)} aria-haspopup="dialog" aria-expanded={giving === r.id}
              title={t('Drag onto another engineer to give 1 point', 'גוררים אל מהנדס אחר כדי להעביר נקודה אחת')}
              onDragStart={e => {e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', r.id); setDragging(r.id);}}
              onDragEnd={() => {setDragging(null); setOver(null);}}
              onKeyDown={e => {if (e.key === 'Enter' || e.key === ' ' || e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {e.preventDefault(); if (canGive(r.id)) setGiving(r.id);}}}
              onContextMenu={e => {e.preventDefault(); endPress(); if (canGive(r.id)) setGiving(r.id);}}
              onPointerDown={e => {if (e.pointerType === 'mouse') return; endPress(); press.current = {x: e.clientX, y: e.clientY, timer: setTimeout(() => {press.current = null; if (canGive(r.id)) setGiving(r.id);}, 500)};}}
              onPointerMove={e => {if (press.current && Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) > 10) endPress();}}
              onPointerUp={endPress} onPointerCancel={endPress}>
              <span className="avatar small" style={{background: member(r.id)?.color}}>{name(r.id).split(' ').map(n => n[0]).join('').slice(0, 2)}</span>
              <span className="plan-member-text"><strong>{name(r.id)}</strong>
                {!!(r.temporary || r.permanent || r.locked) && <span className="plan-chips">
                  {!!r.temporary && <span className="plan-chip temporary"><bdi dir="ltr">{signed(r.temporary)}</bdi> {t('temporary', 'זמני')}</span>}
                  {!!r.permanent && <span className="plan-chip permanent"><bdi dir="ltr">{signed(r.permanent)}</bdi> {t('permanent', 'קבוע')}</span>}
                  {!!r.locked && <span className="plan-chip locked"><LockKeyhole size={10} aria-hidden="true"/><bdi dir="ltr">{points(r.locked)}</bdi> {t('locked', 'נעול')}</span>}
                </span>}
              </span>
            </div>
            </PopoverAnchor><PopoverContent className="allocation-give" align="start" dir={lang === 'he' ? 'rtl' : 'ltr'}
              onCloseAutoFocus={e => {e.preventDefault(); document.querySelector<HTMLElement>(`.plan-row[data-engineer="${CSS.escape(r.id)}"] .plan-member`)?.focus({preventScroll: true});}} aria-label={`${t('Give 1 point to…', 'העברת נקודה אחת אל…')} · ${name(r.id)}`}>
              <p>{t('Give 1 point to…', 'העברת נקודה אחת אל…')}</p>
              {f.totals?.rows.filter(o => o.id !== r.id).map(o => <button key={o.id} type="button" onClick={() => give(r.id, o.id)}>{name(o.id)}<bdi dir="ltr">{points(o.target)}</bdi></button>)}
            </PopoverContent></Popover>
            <div className="plan-adjust" role="cell">
              <button type="button" disabled={f.busy || !down} aria-describedby={!down && !floor ? 'plan-no-receiver' : undefined} aria-label={`${t('Decrease', 'הפחתת')} ${kindLabel} · ${name(r.id)}`} onClick={() => f.edit(r.id, -f.step, kind)}><Minus size={16}/></button>
              <output className="plan-points" aria-live="polite" dir="ltr" aria-label={`${t('Points', 'נקודות')} · ${name(r.id)}`}>{points(r.target)}</output>
              <button type="button" disabled={f.busy || !up} aria-describedby={ceiling ? capNote : !up ? 'plan-no-counterpart' : undefined} aria-label={`${t('Increase', 'הגדלת')} ${kindLabel} · ${name(r.id)}`} onClick={() => f.edit(r.id, f.step, kind)}><Plus size={16}/></button>
            </div>
            {ceiling && <p className="allocation-row-warning" role="note" id={capNote}>{t(`Max punishment here is +${points(r.permanentMax)} (${points(f.totals?.total ?? 0)} points this month)`, `העונש המרבי כאן הוא \u200E+${points(r.permanentMax)} (${points(f.totals?.total ?? 0)} נקודות החודש)`)}</p>}
            {f.ceilings && r.target > f.ceilings[r.id] && <p className="allocation-row-warning" role="note">{t(`Availability allows about ${points(f.ceilings[r.id])}`, `הזמינות מאפשרת בערך ${points(f.ceilings[r.id])}`)}</p>}
            {!f.outcome?.generated && f.ceilings && f.spaced && r.target <= f.ceilings[r.id] && r.target > f.spaced[r.id] && <p className="allocation-row-note" role="note">{t('This needs some back-to-back days', 'יידרשו כמה תורנויות רצופות')}</p>}
            {f.outcome?.generated && r.assigned !== r.target && <p className="allocation-row-warning" role="note">{t(`${points(r.assigned)} scheduled, plan says ${points(r.target)}`, `שובצו ${points(r.assigned)}, בתוכנית ${points(r.target)}`)}</p>}
            {!!f.outcome?.backToBack[r.id] && <p className="allocation-row-note" role="note">{t(`Back-to-back days: ${f.outcome.backToBack[r.id]}`, `תורנויות רצופות: ${f.outcome.backToBack[r.id]}`)}</p>}
          </div>;
        })}
      </div>}
      <p className="allocation-caption">{t('Points = fair share, plus any repayment, plus the temporary and permanent changes. Locked duties count toward points.', 'נקודות = החלק ההוגן, בתוספת החזרים ובתוספת השינויים הזמניים והקבועים. תורנויות נעולות נספרות בנקודות.')}</p>
      {f.draft && <details className="allocation-details" open={unplacedUnits > 0}>
        <summary>{t('Adjustments & compensation', 'שינויים ופיצוי')}{!!owed.length && <span>{owed.length}</span>}</summary>
        {unplacedUnits > 0 && <p className="allocation-attention">{points(unplacedUnits)} {t('pts still need a counterpart', 'נק׳ עדיין דורשות הקצאה נגדית')}</p>}
        {owed.length ? <ul>{owed.map(l => {
          // A lone half cannot be repaid by whole duties; it waits for its second half instead of a later month.
          const lone = loneHalf(l.later), whole = l.later - lone;
          return <li key={`${l.debtorId}>${l.creditorId}`}><strong>{name(l.debtorId)} {lang === 'he' ? '←' : '→'} {name(l.creditorId)}</strong> · <bdi>{points(l.units)}</bdi> · {[
          l.thisMonth && `${points(l.thisMonth)} ${t('this month', 'החודש')}`, whole && `${points(whole)} ${t('later', 'בהמשך')}`,
          lone && t('0.5 waiting for the second half', '0.5 ממתין לחצי השני'),
          l.reason === 'uneven' && t('uneven split', 'חלוקה לא שווה')].filter(Boolean).join(' · ')}</li>;})}</ul>
          : <p>{t('No one owes points.', 'אין נקודות פתוחות.')}</p>}
      </details>}
      {f.closed && <div className="warning-note">{t('Monthly coverage has started. Generation is closed; manual changes, locks and swaps remain available.', 'הכיסוי החודשי התחיל. השיבוץ האוטומטי נסגר; ניתן לערוך ידנית, לנעול ולהחליף תורנויות.')}</div>}
      {(f.structural || f.error) && <div className="warning-note" role="alert">{allocationMessage(f.structural || f.error, t)}</div>}
      {f.notice && <p className="allocation-caption" role="status">{f.notice}</p>}
      {moved && <div className="allocation-toast" role="status" ref={toastRef}><span>{t(`${name(moved.toId)} took 1 point from ${name(moved.fromId)}`, `נקודה אחת הועברה מ־${name(moved.fromId)} אל ${name(moved.toId)}`)} · {t('temporary', 'זמני')}</span><button type="button" disabled={f.busy || !canMakePermanent} onClick={f.makePermanent}>{t('Make permanent', 'להפוך לקבוע')}</button></div>}
      {f.busy && <div className="allocation-progress" role="status"><Sparkles className="spin" size={18}/><div><strong>{status}</strong>{f.progress !== null && <p>{f.progress} {t('dates covered so far', 'תאריכים מכוסים עד כה')}</p>}<small>{t('Your saved assignments stay in place until a verified draft is saved.', 'השיבוצים השמורים נשארים עד לשמירת טיוטה מאומתת.')}</small></div></div>}
    </div>
    <div className="allocation-footer"><div><strong>{f.totals ? `${points(f.totals.configured)} / ${points(f.totals.total)}` : '—'} {t('pts', 'נק׳')}</strong><small>{f.closed ? t('Save targets and locks', 'שמירת יעדים ונעילות') : t('Save to continue later · confirm to generate', 'שמירה להמשך · אישור לשיבוץ')}</small></div>
      <div className="plan-actions">{f.phase === 'generating' ? <Button variant="outline" onClick={f.cancel}>{t('Cancel', 'ביטול')}</Button>
      // A failed read of the month is the only state with nothing to confirm: retry it here.
      : f.retry ? <Button onClick={f.refresh}><RotateCw/>{t('Try again', 'ניסיון נוסף')}</Button>
      : <>
        {/* Saves the whole plan without generating, through the same checked confirmation. After the cutoff the main action already saves. */}
        {!f.closed && <Button variant="outline" className={`plan-save${f.saved ? ' saved' : ''}`} disabled={!f.canConfirm || f.saved} onClick={() => f.confirm(false)}>{f.saved ? <><Check/>{t('Saved', 'נשמר')}</> : <><Save/>{t('Save', 'שמירה')}</>}</Button>}
        <Button disabled={!f.canConfirm || (!f.closed && !f.captured?.generationAllowed)} onClick={() => f.confirm(!f.closed)}><Sparkles/>{f.closed ? t('Save allocation', 'שמירת ההקצאה') : t('Confirm & generate', 'אישור ושיבוץ')}</Button>
      </>}</div></div>
  </EditorDialog>;
}
