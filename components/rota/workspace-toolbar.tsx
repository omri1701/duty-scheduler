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
  generationClosed = false,
  allocationMismatch = false,
  reviewNotes = 0,
  publishBlocked = '',
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
  generationClosed?: boolean;
  allocationMismatch?: boolean;
  /** Notes waiting in Plan the month after Generate; a dot marks them. */
  reviewNotes?: number;
  /** Why Publish is disabled, for its tooltip. */
  publishBlocked?: string;
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
  // A generated month is reviewed (and regenerated) in Plan the month, so the action says so.
  const generateLabel = busy ? t('Generating…','משבץ…') : monthDetails.generated ? t('Review plan','בדיקת התוכנית') : t('Generate month','יצירת שיבוץ');
  const review = monthDetails.generated && !busy;
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
                  disabled={readOnly || busy || (generationClosed && !review) || !metrics.active.length}
                  title={review && reviewNotes ? t('Notes are waiting in Plan the month', 'הערות ממתינות בתכנון החודש') : generationClosed && !review ? t('Coverage has started. Use manual assignments or swaps.', 'הכיסוי החודשי התחיל. יש לערוך ידנית או לבצע החלפות.') : undefined}
                  onClick={runGenerate}
                  aria-label={generateLabel}
                >
                  <Sparkles className={busy ? 'spin' : ''} />
                  <span className="workflow-label">{generateLabel}</span>
                  {review && reviewNotes > 0 && <span className="review-dot" aria-hidden="true"/>}
                </Button>
                {reopened && <Button className="cancel-draft-action" data-draft-action variant="outline" disabled={readOnly || busy} onClick={onCancelDraft}>{t('Cancel draft', 'ביטול טיוטה')}</Button>}
                <Button
                  className="publish-month-action"
                  disabled={
                    readOnly || allocationMismatch || metrics.assigned !== blockCount || !!metrics.conflicts.length || !blockCount
                  }
                  title={publishBlocked || undefined}
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
