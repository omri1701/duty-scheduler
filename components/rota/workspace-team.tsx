import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { TeamList } from '@/components/rota/team-list';
import type { TeamWorkspace } from '@/hooks/use-team-workspace';
import type { State } from '@/lib/rota/engine';
import type { WorkspaceMetrics } from '@/lib/rota/workspace-data';
import type { Language, Translate, UpdateDraft } from './workspace-types';
export function WorkspaceTeam({
  remote,
  state,
  metrics,
  meId,
  isManager,
  lang,
  t,
  update,
}: {
  remote: TeamWorkspace;
  state: State;
  metrics: WorkspaceMetrics;
  meId: string;
  isManager: boolean;
  lang: Language;
  t: Translate;
  update: UpdateDraft;
}) {
  const { active, monthTotals, historyTotals } = metrics;
  return (
    <section className="team-panel">
      <div className="section-heading">
        <div>
          <h3>{t('Team order', 'סדר הצוות')}</h3>
          <p>{t('Most senior → newest', 'הוותיק ביותר ← החדש ביותר')}</p>
        </div>
        <span className="pill">
          {active.length} {t('active engineers', 'מהנדסים פעילים')}
        </span>
      </div>
      <TeamList
        roles={remote.snapshot?.roles ?? []}
        onRole={(id, role) => remote.setRole(id, role).catch((e) => toast.error(e.message))}
        selfId={meId}
        readOnly={!isManager}
        team={state.team}
        monthTotals={monthTotals}
        historyTotals={historyTotals}
        lang={lang}
        onReorder={(team) => update((s) => ({ ...s, team }), false)}
        onActive={(id, active) => {
          update(
            (s) => ({ ...s, team: s.team.map((p) => (p.id === id ? { ...p, active } : p)) }),
            false,
          );
          toast(
            t('Existing assignments are retained for review.', 'שיבוצים קיימים נשמרים לבדיקה.'),
          );
        }}
      />
      {remote && isManager && (
        <div className="membership-requests">
          <h3>{t('Join requests', 'בקשות הצטרפות')}</h3>
          {remote.snapshot?.members.filter((m) => m.status === 'pending').length ? (
            remote.snapshot.members
              .filter((m) => m.status === 'pending')
              .map((m) => (
                <div className="membership-request" key={m.id}>
                  <div>
                    <strong>{m.name}</strong>
                    <small>{m.email}</small>
                  </div>
                  <Button
                    onClick={() =>
                      remote
                        .review(m.id, 'approved')
                        .then(() => toast.success(t('Member approved', 'החבר אושר')))
                        .catch((e) => toast.error(e.message))
                    }
                  >
                    {t('Approve', 'אישור')}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() =>
                      remote.review(m.id, 'rejected').catch((e) => toast.error(e.message))
                    }
                  >
                    {t('Decline', 'דחייה')}
                  </Button>
                </div>
              ))
          ) : (
            <p className="muted-copy">
              {t(
                'No pending requests. Teammates appear here after signing in.',
                'אין בקשות ממתינות. חברי צוות יופיעו כאן לאחר התחברות.',
              )}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
