import { ChevronLeft, ChevronRight, SlidersHorizontal, Sparkles, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { State } from '@/lib/rota/engine';
import type { WorkspaceMetrics } from '@/lib/rota/workspace-data';
import type { Translate } from './workspace-types';
export function WorkspaceToolbar({
  monthLabel,
  monthDetails,
  isManager,
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
  return (
    <div className="month-toolbar">
      <div className="month-title">
        <Button
          variant="outline"
          size="icon"
          onClick={() => changeMonth(-1)}
          aria-label={t('Previous month', 'חודש קודם')}
        >
          <ChevronLeft />
        </Button>
        <h2>{monthLabel}</h2>
        <Button
          variant="outline"
          size="icon"
          onClick={() => changeMonth(1)}
          aria-label={t('Next month', 'חודש הבא')}
        >
          <ChevronRight />
        </Button>
        <span className={'status-badge ' + monthDetails.status}>
          {monthDetails.status === 'published' ? t('Published', 'פורסם') : t('Draft', 'טיוטה')}
        </span>
      </div>
      <div className="toolbar-actions">
        {isManager && (
          <>
            <Button variant="outline" onClick={onHistory}>
              {t('Versions', 'גרסאות')}
            </Button>
            <Button
              variant="outline"
              aria-label={t('Change month deadline', 'שינוי מועד אחרון לחודש')}
              onClick={onSettings}
            >
              <SlidersHorizontal />
              {t('Change month deadline', 'שינוי מועד אחרון לחודש')}
            </Button>
            {monthDetails.status === 'published' ? (
              <Button onClick={onReopen}>{t('Reopen draft', 'פתיחת טיוטה')}</Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  disabled={busy || !metrics.active.length}
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
                    metrics.assigned !== blockCount || !!metrics.conflicts.length || !blockCount
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
