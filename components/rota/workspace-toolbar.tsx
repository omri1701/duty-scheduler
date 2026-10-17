import {MonthHeading} from './month-heading';
import { SlidersHorizontal, Sparkles, Check, Ellipsis, History } from 'lucide-react';
import {DropdownMenu} from 'radix-ui';
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
  return (
    <div className="month-toolbar">
      <MonthHeading label={monthLabel} status={monthDetails.status} t={t} onChange={changeMonth}/>
      <div className="toolbar-actions">
        {isManager && (
          <>
            {mobile ? (
              <DropdownMenu.Root dir={t('ltr', 'rtl') as 'ltr' | 'rtl'}>
                <DropdownMenu.Trigger asChild>
                  <Button variant="outline" size="icon" aria-label={t('Month actions', 'פעולות לחודש')}>
                    <Ellipsis />
                  </Button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content className="mobile-action-menu" align="end" sideOffset={8} collisionPadding={16}>
                    <DropdownMenu.Item onSelect={onHistory}>
                      <History />{t('Versions', 'גרסאות')}
                    </DropdownMenu.Item>
                    <DropdownMenu.Item disabled={readOnly} onSelect={onSettings}>
                      <SlidersHorizontal />{t('Change month deadline', 'שינוי מועד אחרון לחודש')}
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
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
