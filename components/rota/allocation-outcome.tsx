import {Button} from '@/components/ui/button';
import {allocationTotals} from '@/lib/allocation/review';
import type {AllocationWorkflow} from '@/hooks/use-allocation-workflow';
import type {State} from '@/lib/rota/engine';
import type {Language, Translate} from './workspace-types';
import {shortDate} from '@/lib/date-format';

export function AllocationOutcome({flow, state, lang, t}: {flow: AllocationWorkflow; state: State; lang: Language; t: Translate}) {
  const c = flow.captured;
  if (!c?.allocation) return null;
  const totals = allocationTotals(c.input, c.allocation, c.assignments);
  const mismatch = totals.rows.some(r => r.assigned !== r.target);
  return <section className={`allocation-outcome${totals.uncovered.length ? ' partial' : ''}`} aria-label={t('Allocation result', 'תוצאת ההקצאה')}>
    <div className="allocation-outcome-heading"><div><strong>{totals.uncovered.length ? t('Partial · Requires Manager Resolution', 'חלקי · נדרשת החלטת מנהל') : t('All duties covered', 'כל התורנויות מכוסות')}</strong><p>{flow.result && !flow.result.search.allStagesProved ? t('Best found; search limit reached.', 'התוצאה הטובה שנמצאה; מגבלת החיפוש הושגה.') : totals.uncovered.length ? t('Confirmed targets retained. Resolve uncovered dates before publishing.', 'היעדים המאושרים נשמרו. יש להשלים כיסוי לפני הפרסום.') : mismatch ? t('Assignments differ from confirmed targets. Review before publication.', 'השיבוצים שונים מהיעדים המאושרים. יש לבדוק לפני הפרסום.') : t('Actual primary points against confirmed targets.', 'נקודות ראשיות בפועל מול היעדים המאושרים.')}</p></div><Button size="sm" variant="outline" disabled={flow.busy} onClick={flow.show}>{t('Review allocation', 'בדיקת ההקצאה')}</Button></div>
    <details><summary>{t('Assigned / target · missing points', 'שובצו / יעד · נקודות חסרות')}</summary><div className="allocation-result-grid">{totals.rows.map(r => <div key={r.id}><span>{state.team.find(p => p.id === r.id)?.name}</span><strong><bdi>{r.assigned / 2} / {r.target / 2}</bdi></strong><small>{r.missing ? `${r.missing / 2} ${t('missing', 'חסרות')}` : r.assigned > r.target ? t('Above target — review', 'מעל היעד — נדרשת בדיקה') : t('Met', 'הושלם')}</small></div>)}</div></details>
    {!!totals.uncovered.length && <p className="allocation-uncovered"><strong>{t('Uncovered dates', 'תאריכים ללא כיסוי')}: </strong>{totals.uncovered.map(d => shortDate(d, lang)).join(' · ')}</p>}
  </section>;
}
