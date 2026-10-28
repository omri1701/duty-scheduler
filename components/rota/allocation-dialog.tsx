'use client';
import {Check, LockKeyhole, Minus, Plus, RotateCcw, Sparkles} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {EditorDialog} from './editor-dialog';
import type {State} from '@/lib/rota/engine';
import type {AllocationWorkflow} from '@/hooks/use-allocation-workflow';
import type {Language, Translate} from './workspace-types';
import {shortDate} from '@/lib/date-format';

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
  const isPlanning = ['proposing', 'editing', 'checking'].includes(f.phase);
  const partial = f.check?.feasibility === 'partial';
  const status = f.phase === 'loading' ? t('Loading the authoritative month…', 'טוען את נתוני החודש…')
    : f.phase === 'proposing' ? t('Preparing a balanced proposal…', 'מכין הצעה מאוזנת…')
    : f.phase === 'editing' ? t('Redistributing points…', 'מחלק את הנקודות מחדש…')
    : f.phase === 'checking' ? t('Checking this allocation…', 'בודק את ההקצאה…')
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
        {f.totals?.rows.map((r, index) => <div className="allocation-row" role="row" key={r.id} data-engineer={r.id}>
          <div className="allocation-engineer" role="rowheader"><span className="allocation-rank">{String(index + 1).padStart(2, '0')}</span><span className="avatar small" style={{background: state.team.find(p => p.id === r.id)?.color}}>{name(r.id).split(' ').map(n => n[0]).join('').slice(0, 2)}</span><strong>{name(r.id)}</strong></div>
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
        </div>)}
      </div>}
      <p className="allocation-caption">{t('Target includes Permanent. Generate is Target minus Locked; it may require a partial schedule.', 'היעד כולל את השינוי הקבוע. לשיבוץ = יעד פחות נעול; ייתכן שיתקבל שיבוץ חלקי.')}</p>
      {f.draft && <details className="allocation-details" open={!!f.draft.pending.length}>
        <summary>{t('Adjustments & compensation', 'שינויים ופיצוי')}{!!f.draft.transfers.length && <span>{f.draft.transfers.length}</span>}</summary>
        <p>{t('Target changes are temporary: carried work can be returned in a future month. Permanent changes do not create compensation.', 'שינויי יעד הם זמניים: ניתן להחזיר עבודה בחודש עתידי. שינויים קבועים אינם יוצרים פיצוי.')}</p>
        <ul>{f.draft.transfers.map(tr => <li key={tr.id}><strong>{name(tr.fromId)} → {name(tr.toId)}</strong> · {points(tr.units)} {t('pts', 'נק׳')} · {tr.kind === 'temporary' ? t('Temporary', 'זמני') : t('Permanent', 'קבוע')}</li>)}</ul>
        {f.draft.pending.map(p => <p className="allocation-attention" key={p.id}>{name(p.engineer)} · {signed(p.deltaUnits)} · {p.kind === 'temporary' ? t('Temporary', 'זמני') : t('Permanent', 'קבוע')} · {t('needs a counterpart', 'נדרשת הקצאה נגדית')}</p>)}
        {f.draft.repayments.map((r, i) => <p key={i}>{name(r.claim.debtorId)} → {name(r.claim.creditorId)} · {points(r.units)} {t('pts proposed repayment', 'נק׳ להחזרה מתוכננת')}</p>)}
        <p>{t('Only actual primary assignments fund compensation when published. Unperformed repayment stays outstanding.', 'הפיצוי מבוסס רק על שיבוצים ראשיים בפועל בעת הפרסום. החזרה שלא בוצעה נשארת פתוחה.')}</p>
        <div className="allocation-compensation"><strong>{t('Owed relief now → at month opening', 'הקלת עומס כעת ← בפתיחת החודש')}</strong>{f.input?.seniority.filter(id => f.captured?.actual.net[id] || f.captured?.projected.net[id]).map(id => <p key={id}>{name(id)} <bdi>{signed(f.captured!.actual.net[id] ?? 0)} → {signed(f.captured!.projected.net[id] ?? 0)}</bdi></p>)}<small>{t('Positive: owed relief · Negative: owes work. Future work is a projection until completed.', 'חיובי: זכאות להקלה · שלילי: עבודה להחזרה. עבודה עתידית היא תחזית עד להשלמתה.')}</small></div>
      </details>}
      {f.closed && <div className="warning-note">{t('Monthly coverage has started. Generation is closed; manual changes, locks and swaps remain available.', 'הכיסוי החודשי התחיל. השיבוץ האוטומטי נסגר; ניתן לערוך ידנית, לנעול ולהחליף תורנויות.')}</div>}
      {(f.structural || f.error) && <div className="warning-note" role="alert">{allocationMessage(f.structural || f.error, t)}</div>}
      {!f.busy && f.draft && !f.structural && !f.error && <div className="allocation-validation" role="status"><Check size={16}/>{partial ? t('A partial schedule can be generated. Uncovered dates will need your review.', 'ניתן ליצור שיבוץ חלקי. תאריכים ללא כיסוי יידרשו לבדיקה.') : f.check?.feasibility === 'complete' ? t('Full coverage is possible with these targets.', 'ניתן לכסות את כל התורנויות עם היעדים האלה.') : t('Full coverage is not yet established. Generate will search these exact targets.', 'כיסוי מלא טרם הוכח. השיבוץ יחפש פתרון עם היעדים המדויקים האלה.')}</div>}
      {!!f.check?.diagnostics.some(d => ['no-primary-candidates', 'insufficient-individual-capacity', 'unreachable-target-combination', 'shared-capacity-shortage', 'secondary-needs-publication-review'].includes(d.code)) && <details className="allocation-details"><summary>{t('Coverage checks', 'בדיקות כיסוי')}</summary>{f.check.diagnostics.filter(d => ['no-primary-candidates', 'insufficient-individual-capacity', 'unreachable-target-combination', 'shared-capacity-shortage', 'secondary-needs-publication-review'].includes(d.code)).map((d, i) => <p key={i}>{d.engineer && <strong>{name(d.engineer)} · </strong>}{d.dates?.map(date => shortDate(date, lang)).join(', ')} {d.code === 'no-primary-candidates' ? t('No available primary engineer on these dates.', 'אין מהנדס ראשי זמין בתאריכים אלה.') : d.code === 'secondary-needs-publication-review' ? t('Review the preserved emergency cover before publication.', 'יש לבדוק את כיסוי החירום שנשמר לפני הפרסום.') : d.code === 'unreachable-target-combination' ? t('Available duty weights cannot meet this exact target. Partial output remains available.', 'משקלי התורנויות הזמינות אינם מאפשרים להגיע ליעד המדויק. ניתן ליצור שיבוץ חלקי.') : d.code === 'shared-capacity-shortage' ? t('Engineers share too few available duties to meet every target.', 'אין מספיק תורנויות זמינות משותפות כדי להגיע לכל היעדים.') : t('Available primary capacity is below the requested target.', 'הקיבולת הזמינה לתורנויות ראשיות נמוכה מהיעד המבוקש.')}</p>)}</details>}
      {f.notice && <p className="allocation-caption" role="status">{f.notice}</p>}
      {f.busy && <div className="allocation-progress" role="status"><Sparkles className="spin" size={18}/><div><strong>{status}</strong>{f.progress !== null && <p>{f.progress} {t('dates covered so far', 'תאריכים מכוסים עד כה')}</p>}<small>{t('Your saved assignments stay in place until a verified draft is saved.', 'השיבוצים השמורים נשארים עד לשמירת טיוטה מאומתת.')}</small></div></div>}
      <div className="allocation-secondary-actions"><Button variant="ghost" size="sm" disabled={f.busy} onClick={f.refreshReview}>{t('Refresh & review retained targets', 'רענון ובדיקת היעדים שנשמרו')}</Button><Button variant="ghost" size="sm" disabled={f.busy || f.closed || !f.input} onClick={f.propose}>{t('Use a new proposal', 'שימוש בהצעה חדשה')}</Button>{!f.closed && <Button variant="ghost" size="sm" disabled={!f.canConfirm} onClick={() => f.confirm(false)}>{t('Save allocation only', 'שמירת ההקצאה בלבד')}</Button>}</div>
    </div>
    <div className="allocation-footer"><div><strong>{f.totals ? `${points(f.totals.configured)} / ${points(f.totals.total)}` : '—'} {t('pts', 'נק׳')}</strong><small>{t('Confirm targets · save as draft', 'אישור יעדים · שמירה כטיוטה')}</small></div>{f.phase === 'generating' || isPlanning ? <Button variant="outline" onClick={f.cancel}>{t('Cancel', 'ביטול')}</Button> : <Button disabled={!f.canConfirm || (!f.closed && !f.captured?.generationAllowed)} onClick={() => f.confirm(!f.closed)}><Sparkles/>{f.closed ? t('Save allocation', 'שמירת ההקצאה') : partial ? t('Generate partial', 'יצירת שיבוץ חלקי') : t('Confirm & generate', 'אישור ושיבוץ')}</Button>}</div>
  </EditorDialog>;
}
