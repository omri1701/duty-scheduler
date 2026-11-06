import {useEffect, useState} from 'react';
import {toast} from 'sonner';
import {ChevronLeft, ChevronRight, UserPlus, Users} from 'lucide-react';
import {TemporaryMemberDialog} from './temporary-member-dialog';
import {MemberSheet} from './member-sheet';
import type {Member} from '@/lib/supabase/snapshot';
import {Button} from '@/components/ui/button';
import {Card, SectionTitle} from '@/components/ui/card';
import {ListRow} from '@/components/ui/list-row';
import {EmptyState} from '@/components/ui/empty-state';
import {CountUp} from '@/components/ui/count-up';
import {TeamList} from '@/components/rota/team-list';
import type {TeamWorkspace} from '@/hooks/use-team-workspace';
import type {Balance} from '@/lib/supabase/balance';
import {addDays, dayOf, type State} from '@/lib/rota/engine';
import type {WorkspaceMetrics} from '@/lib/rota/workspace-data';
import type {Language, Translate, UpdateDraft} from './workspace-types';
import {userMessage} from '@/lib/messages';

/** The Team tab (decision 2026-11-06): this month's coverage, the ordered team with points and
 * the live balance, a member sheet, and join requests for admins. */
export function WorkspaceTeam({remote, state, metrics, monthLabel, onMonth, meId, isManager, lang, t, update}: {
  remote: TeamWorkspace; state: State; metrics: WorkspaceMetrics; monthLabel: string; onMonth: (offset: number) => void; meId: string; isManager: boolean; lang: Language; t: Translate; update: UpdateDraft;
}) {
  const {active, monthTotals, historyTotals, owned, assigned} = metrics;
  const [editing, setEditing] = useState<Member | null | undefined>(undefined), [selected, setSelected] = useState<string | null>(null);
  const temporaryMembers = remote.snapshot?.members.filter(m => m.is_temporary) ?? [];
  const [balance, setBalance] = useState<{revision: number; value: Balance | null} | null>(null);
  const revision = remote.snapshot?.revision, load = remote.balance;
  useEffect(() => {
    if (revision == null) return;
    let alive = true;
    // Every published change advances the revision. An older database without the read RPC simply shows no number.
    load().then(value => {if (alive) setBalance({revision, value});}, () => {if (alive) setBalance({revision, value: null});});
    return () => {alive = false;};
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load is recreated each render; revision is the trigger.
  }, [revision]);
  const rtl = lang === 'he', Prev = rtl ? ChevronRight : ChevronLeft, Next = rtl ? ChevronLeft : ChevronRight;
  const points = owned.reduce((v, b) => v + b.points, 0);
  const pending = remote.snapshot?.members.filter((m) => m.status === 'pending') ?? [];
  const noWeekendIds = remote.snapshot?.members.filter((m) => m.no_weekends).map((m) => m.id) ?? [];
  const member = state.team.find(p => p.id === selected) ?? null;
  const fail = (e: unknown) => toast.error(userMessage((e as Error).message, t));
  const setActive = (id: string, value: boolean) => {
    update((s) => ({...s, team: s.team.map((p) => (p.id === id ? {...p, active: value} : p))}), false);
    if (!value) toast(t('Existing duties are kept for review', 'שיבוצים קיימים נשמרים לבדיקה'));
  };
  return <>
    <section className="team-screen">
      <div className="month-bar">
        <div className="month-title">
          <Button variant="ghost" size="icon" aria-label={t('Previous month', 'חודש קודם')} onClick={() => onMonth(-1)}><Prev/></Button>
          <h2>{monthLabel}</h2>
          <Button variant="ghost" size="icon" aria-label={t('Next month', 'חודש הבא')} onClick={() => onMonth(1)}><Next/></Button>
        </div>
      </div>
      <Card tone="brand" className="coverage-card">
        <div className="coverage-number"><CountUp value={assigned} decimals={0}/><span>/ {owned.length}</span></div>
        <div className="coverage-copy">{t('duties covered', 'תורנויות משובצות')}</div>
        <div className="coverage-track"><span style={{width: `${owned.length ? (assigned / owned.length) * 100 : 0}%`}}/></div>
        <div className="coverage-bottom"><span>{active.length} {t('engineers', 'מהנדסים')}</span><span>{points} {t('points', 'נקודות')}</span></div>
      </Card>
      <SectionTitle action={isManager && !remote.readOnly && <Button variant="ghost" size="pill" disabled={remote.saving} onClick={() => setEditing(null)}><UserPlus/>{t('Add temporary', 'הוספת זמני')}</Button>}>
        {t('Team', 'הצוות')} · {active.length}
      </SectionTitle>
      <Card inset className="team-card">
        <TeamList
          temporaryIds={temporaryMembers.map(m => m.id)}
          balance={balance?.value ?? null}
          name={id => remote.snapshot?.members.find(m => m.id === id)?.name ?? t('Former teammate', 'חבר צוות לשעבר')}
          roles={remote.snapshot?.roles ?? []}
          noWeekendIds={noWeekendIds}
          selfId={meId}
          readOnly={remote.readOnly || !isManager}
          saving={remote.saving}
          team={state.team}
          revision={remote.snapshot?.revision ?? 0}
          monthTotals={monthTotals}
          historyTotals={historyTotals}
          lang={lang}
          onReorder={(team) => update((s) => ({...s, team}), false, false)}
          onActive={setActive}
          onSelect={setSelected}
        />
      </Card>
      {isManager && <>
        <SectionTitle>{t('Join requests', 'בקשות הצטרפות')}</SectionTitle>
        <Card inset>
          {pending.length ? pending.map((m) => <ListRow key={m.id} className="membership-request" title={m.name} subtitle={m.email}
            trail={<span className="row-buttons">
              <Button size="sm" disabled={remote.readOnly} onClick={() => remote.review(m.id, 'approved').then(() => toast.success(t('Approved', 'אושר'))).catch(fail)}>{t('Approve', 'אישור')}</Button>
              <Button size="sm" variant="ghost" disabled={remote.readOnly} onClick={() => remote.review(m.id, 'rejected').catch(fail)}>{t('Decline', 'דחייה')}</Button>
            </span>}/>)
            : <EmptyState icon={<Users/>}>{t('No one is waiting', 'אין ממתינים')}</EmptyState>}
        </Card>
      </>}
    </section>
    <MemberSheet member={member} open={!!member} onClose={() => setSelected(null)} lang={lang} t={t} selfId={meId} admin={isManager && !remote.readOnly} saving={!!remote.saving}
      roles={remote.snapshot?.roles ?? []} temporary={!!member && temporaryMembers.some(m => m.id === member.id)} noWeekends={!!member && noWeekendIds.includes(member.id)}
      monthPoints={member ? monthTotals[member.id] ?? 0 : 0} allPoints={member ? historyTotals[member.id] ?? 0 : 0} balance={balance?.value ?? null}
      name={id => remote.snapshot?.members.find(m => m.id === id)?.name ?? t('Former teammate', 'חבר צוות לשעבר')} team={state.team}
      onRole={role => {if (member) remote.setRole(member.id, role).catch(fail);}}
      onNoWeekends={value => {
        if (!member) return;
        remote.setNoWeekends(member.id, value).then(() => {
          // Locked weekends in an open draft are kept, never deleted.
          const drafts = Object.keys(state.months).filter((m) => state.months[m].status === 'draft');
          const locked = Object.entries(state.assignments).some(([day, a]) => a.primary === member.id && a.locked && [5, 6].includes(dayOf(day)) && drafts.includes((dayOf(day) === 6 ? addDays(day, -1) : day).slice(0, 7)));
          if (value && locked) toast.warning(t('A locked weekend is kept. Unlock it in the calendar to free it.', 'סוף שבוע נעול נשמר. אפשר לבטל את הנעילה בלוח כדי לשחרר אותו.'));
        }).catch(fail);
      }}
      onActive={value => {if (member) setActive(member.id, value);}}
      // An admin's colour override travels with the team rows of the checked schedule save.
      onColor={hex => {if (member) update((s) => ({...s, team: s.team.map((p) => (p.id === member.id ? {...p, color: hex} : p))}), false);}}
      onRename={member && temporaryMembers.some(m => m.id === member.id) ? () => setEditing(temporaryMembers.find(m => m.id === member.id)) : undefined}/>
    {editing !== undefined && isManager && !remote.readOnly && <TemporaryMemberDialog member={editing} remote={remote} lang={lang} onClose={() => setEditing(undefined)}/>}
  </>;
}
