import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { TemporaryMemberDialog } from './temporary-member-dialog';
import type { Member } from '@/lib/supabase/snapshot';
import { Button } from '@/components/ui/button';
import { TeamList } from '@/components/rota/team-list';
import type { TeamWorkspace } from '@/hooks/use-team-workspace';
import type { Balance } from '@/lib/supabase/balance';
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
  const [editing,setEditing]=useState<Member|null|undefined>(undefined);
  const temporaryMembers=remote.snapshot?.members.filter(m=>m.is_temporary)??[];
  const [balance,setBalance]=useState<{revision:number;value:Balance|null}|null>(null);
  const revision=remote.snapshot?.revision,load=remote.balance;
  useEffect(()=>{
    if(revision==null)return;
    let alive=true;
    // Every published change advances the revision. An older database without
    // the read RPC simply shows no number.
    load().then(value=>{if(alive)setBalance({revision,value})},()=>{if(alive)setBalance({revision,value:null})});
    return()=>{alive=false};
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load is recreated each render; revision is the trigger.
  },[revision]);
  return (
    <><section className="team-panel">
      <div className="section-heading">
        <div>
          <h3>{t('Team order', 'סדר הצוות')}</h3>
          <p>{t('Most senior → newest', 'הוותיק ביותר ← החדש ביותר')}</p>
        </div>
        <span className="pill">
          {active.length} {t('active engineers', 'מהנדסים פעילים')}
        </span>
      </div>
      {isManager&&!remote.readOnly&&<Button disabled={remote.saving} onClick={()=>setEditing(null)}>{t('Add Temporary Member','הוספת חבר זמני')}</Button>}
      <TeamList
        temporaryIds={temporaryMembers.map(m=>m.id)}
        balance={balance?.value??null}
        name={id=>remote.snapshot?.members.find(m=>m.id===id)?.name??t('Former teammate','חבר צוות לשעבר')}
        onRename={id=>setEditing(temporaryMembers.find(m=>m.id===id))}
        roles={remote.snapshot?.roles ?? []}
        onRole={(id, role) => remote.setRole(id, role).catch((e) => toast.error(e.message))}
        selfId={meId}
        readOnly={remote.readOnly||!isManager}
        saving={remote.saving}
        team={state.team}
        revision={remote.snapshot?.revision ?? 0}
        monthTotals={monthTotals}
        historyTotals={historyTotals}
        lang={lang}
        onReorder={(team) => update((s) => ({ ...s, team }), false, false)}
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
                    disabled={remote.readOnly}
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
                    disabled={remote.readOnly}
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
    </section>{editing!==undefined&&isManager&&!remote.readOnly&&<TemporaryMemberDialog member={editing} remote={remote} lang={lang} onClose={()=>setEditing(undefined)}/>}</>
  );
}
