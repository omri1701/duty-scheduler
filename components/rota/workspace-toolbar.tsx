import {MonthHeading} from './month-heading';
import { SlidersHorizontal, Sparkles, Check, Ellipsis, History } from 'lucide-react';
import {DropdownMenu} from 'radix-ui';
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
  reopened,
  onCancelDraft,
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
  reopened: boolean;
  onCancelDraft: () => void;
}) {
  const generateLabel = busy ? t('Generating…','משבץ…') : monthDetails.generated ? t('Regenerate','שיבוץ מחדש') : t('Generate month','יצירת שיבוץ');
  return (
    <div className="month-toolbar-container">
    <div className="month-toolbar" dir={t('ltr','rtl')}>
      {isManager && <div className="desktop-month-tools">
        <Button data-month-tool="versions" variant="outline" onClick={onHistory}><History/>{t('Versions','גרסאות')}</Button>
        <Button data-month-tool="deadline" variant="outline" disabled={readOnly} onClick={onSettings}>
          <SlidersHorizontal/>{t('Change month deadline','שינוי מועד אחרון לחודש')}
        </Button>
      </div>}
      <MonthHeading label={monthLabel} t={t} onChange={changeMonth}/>
      <div className={'toolbar-actions'+(reopened ? ' reopened-actions' : '')}>
        {isManager && (
          <>
            {(
              <DropdownMenu.Root dir={t('ltr', 'rtl') as 'ltr' | 'rtl'}>
                <DropdownMenu.Trigger asChild>
                  <Button className="month-actions-menu" variant="outline" size="icon" aria-label={t('Month actions', 'פעולות לחודש')}>
                    <Ellipsis />
                  </Button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content className="mobile-action-menu" align="start" sideOffset={8} collisionPadding={16}>
                    <DropdownMenu.Item onSelect={onHistory}>
                      <History />{t('Versions', 'גרסאות')}
                    </DropdownMenu.Item>
                    <DropdownMenu.Item disabled={readOnly} onSelect={onSettings}>
                      <SlidersHorizontal />{t('Change month deadline', 'שינוי מועד אחרון לחודש')}
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            )}
            <div className="workflow-actions">
            {monthDetails.status === 'published' ? (
              <Button data-draft-action disabled={readOnly} onClick={onReopen}>{t('Reopen draft', 'פתיחת טיוטה')}</Button>
            ) : (
              <>
                <Button
                  className="generate-month-action"
                  variant="outline"
                  disabled={readOnly || busy || !metrics.active.length}
                  onClick={runGenerate}
                  aria-label={generateLabel}
                >
                  <Sparkles className={busy ? 'spin' : ''} />
                  <span className="workflow-label">{generateLabel}</span>
                </Button>
                {reopened && <Button className="cancel-draft-action" data-draft-action variant="outline" disabled={readOnly || busy} onClick={onCancelDraft}>{t('Cancel draft', 'ביטול טיוטה')}</Button>}
                <Button
                  className="publish-month-action"
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
            </div>
          </>
        )}
      </div>
    </div>
    </div>
  );
}
