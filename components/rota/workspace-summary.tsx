import { ArrowRight, CalendarDays } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ink, type State } from '@/lib/rota/engine';
import type { WorkspaceMetrics } from '@/lib/rota/workspace-data';
import type { Translate, FormatDate } from './workspace-types';

export function WorkspaceSummary({
  metrics,
  blockCount,
  monthDetails,
  meId,
  isManager,
  t,
  fmt,
  onTeam,
  onSettings,
}: {
  metrics: WorkspaceMetrics;
  blockCount: number;
  monthDetails: State['months'][string];
  meId: string;
  isManager: boolean;
  t: Translate;
  fmt: FormatDate;
  onTeam: () => void;
  onSettings: () => void;
}) {
  const { assigned, active, owned, monthTotals } = metrics;
  return (
    <aside className="side-panel">
      <div className="coverage-card">
        <div className="eyebrow">{t('THIS MONTH', 'החודש')}</div>
        <div className="coverage-number">
          {assigned}
          <span>/ {blockCount}</span>
        </div>
        <div>{t('duties covered', 'תורנויות משובצות')}</div>
        <div className="coverage-track">
          <span style={{ width: `${(assigned / blockCount) * 100}%` }} />
        </div>
        <div className="coverage-bottom">
          <span>
            {active.length} {t('engineers', 'מהנדסים')}
          </span>
          <span>
            {owned.reduce((v, b) => v + b.points, 0)}{' '}
            {t('base + special pts', 'נקודות בסיס ומיוחדות')}
          </span>
        </div>
      </div>
      <div className="fairness-card">
        <div className="panel-title">
          <h3>{t('The balance', 'האיזון')}</h3>
          <span>{t('POINTS', 'נקודות')}</span>
        </div>
        <div className="balance-list">
          {active.map((p) => (
            <div className="balance-row" key={p.id}>
              <span className="avatar small" style={{ background: p.color, color: ink(p.color) }}>
                {p.name
                  .split(' ')
                  .map((n) => n[0])
                  .join('')
                  .slice(0, 2)}
              </span>
              <div className="balance-person">
                <span>
                  {p.name}
                  {p.id === meId && <small> · {t('you', 'אני')}</small>}
                </span>
                <div className="balance-track">
                  <span
                    style={{
                      background: p.color,
                      width: `${(Math.max(0, monthTotals[p.id]) / Math.max(4, ...Object.values(monthTotals))) * 100}%`,
                    }}
                  />
                </div>
              </div>
              <strong>{monthTotals[p.id] || 0}</strong>
            </div>
          ))}
        </div>
        <Button variant="ghost" className="full-width" onClick={onTeam}>
          {t('Manage team & order', 'ניהול הצוות והסדר')}
          <ArrowRight />
        </Button>
      </div>
      <div className="deadline-card">
        <CalendarDays size={18} />
        <div>
          <strong>{t('Constraints due', 'מועד אחרון לאילוצים')}</strong>
          <p>
            {fmt(monthDetails.deadline)} ·{' '}
            {isManager
              ? t('chosen by you', 'לבחירתך')
              : t('set by your manager', 'נקבע על ידי המנהל')}
          </p>
        </div>
        <button style={{ display: isManager ? undefined : 'none' }} onClick={onSettings}>
          {t('Edit', 'עריכה')}
        </button>
      </div>
    </aside>
  );
}
