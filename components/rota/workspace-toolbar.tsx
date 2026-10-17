import {MonthHeading} from './month-heading';
import { SlidersHorizontal, Sparkles, Check, Ellipsis } from 'lucide-react';
import {useRef,useState} from 'react';
import {DeferredFeature,deferred} from './deferred-feature';
const MonthActions=deferred(()=>import('./month-actions').then(m=>m.MonthActions));
import {useMobileLayout} from '@/hooks/use-mobile-layout';
import { Button } from '@/components/ui/button';
import type { State } from '@/lib/rota/engine';
import type { WorkspaceMetrics } from '@/lib/rota/workspace-data';
import type { Translate } from './workspace-types';
export function WorkspaceToolbar({
  monthLabel,
  monthDetails,
  isManager,
  readOnly,
  busy,
  metrics,
  blockCount,
  t,
  changeMonth,
  runGenerate,
  onHistory,
  onSettings,
  onReopen,
  onPublish,
}: {
  monthLabel: string;
  monthDetails: State['months'][string];
  isManager: boolean;
  readOnly: boolean;
  busy: boolean;
  metrics: WorkspaceMetrics;
  blockCount: number;
  t: Translate;
  changeMonth: (offset: number) => void;
  runGenerate: () => void;
  onHistory: () => void;
  onSettings: () => void;
  onReopen: () => void;
  onPublish: () => void;
}) {
  const mobile = useMobileLayout();
  const [menuRequested,setMenuRequested]=useState(false),menuTrigger=useRef<HTMLButtonElement>(null);
  return (
    <div className="month-toolbar">
      <MonthHeading label={monthLabel} status={monthDetails.status} t={t} onChange={changeMonth}/>
      <div className="toolbar-actions">
        {isManager && (
          <>
            {mobile ? (
              menuRequested?<DeferredFeature lang={t('en','he') as 'en'|'he'} onClose={()=>{setMenuRequested(false);queueMicrotask(()=>menuTrigger.current?.focus())}}><MonthActions t={t} readOnly={readOnly} onHistory={onHistory} onSettings={onSettings}/></DeferredFeature>:
              <Button ref={menuTrigger} variant="outline" size="icon" aria-label={t('Month actions', 'פעולות לחודש')} aria-haspopup="menu" aria-expanded={false}
                onClick={()=>setMenuRequested(true)} onKeyDown={event=>{if(event.key==='ArrowDown'){event.preventDefault();setMenuRequested(true)}}}><Ellipsis/></Button>
            ) : <><Button variant="outline" onClick={onHistory}>
              {t('Versions', 'גרסאות')}
            </Button>
            <Button
              variant="outline"
              aria-label={t('Change month deadline', 'שינוי מועד אחרון לחודש')}
              onClick={onSettings}
              disabled={readOnly}
            >
              <SlidersHorizontal />
              {t('Change month deadline', 'שינוי מועד אחרון לחודש')}
            </Button>
            </>}
            {monthDetails.status === 'published' ? (
              <Button disabled={readOnly} onClick={onReopen}>{t('Reopen draft', 'פתיחת טיוטה')}</Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  disabled={readOnly || busy || !metrics.active.length}
                  onClick={runGenerate}
                >
                  <Sparkles className={busy ? 'spin' : ''} />
                  {busy
                    ? t('Generating…', 'משבץ…')
                    : monthDetails.generated
                      ? t('Regenerate', 'שיבוץ מחדש')
                      : t('Generate month', 'יצירת שיבוץ')}
                </Button>
                <Button
                  disabled={
                    readOnly || metrics.assigned !== blockCount || !!metrics.conflicts.length || !blockCount
                  }
                  onClick={onPublish}
                >
                  <Check />
                  {t('Publish', 'פרסום')}
                </Button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
