'use client';
import {useEffect, useRef, useState} from 'react';
import {ArrowLeftRight, CalendarCheck, CalendarDays, Inbox, Scale, ShieldCheck, Users} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Card, SectionTitle} from '@/components/ui/card';
import {ListRow} from '@/components/ui/list-row';
import {Chip} from '@/components/ui/chip';
import {CountUp} from '@/components/ui/count-up';
import {EmptyState} from '@/components/ui/empty-state';
import {Skeleton} from '@/components/ui/skeleton';
import type {TeamWorkspace} from '@/hooks/use-team-workspace';
import type {Balance} from '@/lib/supabase/balance';
import {addDays, calendarMonthLabel} from '@/lib/rota/calendar-dates';
import {shortDate} from '@/lib/date-format';
import type {Language, Translate} from '@/components/rota/workspace-types';
import {constraintsDue, dutyWhen, greeting, myUpcomingDuties, type MyDuty} from './home-data';
import {SwapCard, type SwapActions} from '@/components/rota/swap-requests';
import {swapNeedsAction} from '@/lib/supabase/swaps';

/** The first tab (decision 2026-11-06): greeting, the next duties, and only what needs the member now. */
export function HomeScreen({remote, swaps, today, lang, t, onSchedule, onAvailability, onTeam, onSwap}: {
  remote: TeamWorkspace; swaps: SwapActions; today: string; lang: Language; t: Translate;
  onSchedule: (month: string) => void; onAvailability: (month: string) => void; onTeam: () => void;
  /** Starts a swap for the member's own published duty on that day. */
  onSwap: (month: string, day: string) => void;
}) {
  const raw = remote.snapshot!, me = remote.user!.id, admin = remote.isAdmin;
  const name = (id: string | null) => raw.members.find(m => m.id === id)?.name ?? '';
  const first = (remote.me?.name ?? '').trim().split(/\s+/)[0] || '';
  const duties = myUpcomingDuties(raw, me, today);
  const due = constraintsDue(raw, today, admin);
  // Requests that wait for the member (or the admin), then the member's own open ones.
  const toAnswer = swaps.requests.filter(r => swapNeedsAction(r, me, admin, swaps.temporary));
  const mine = swaps.requests.filter(r => !toAnswer.includes(r) && ['awaiting_engineer', 'awaiting_admin'].includes(r.status));
  const pending = admin ? raw.members.filter(m => m.status === 'pending').length : 0;
  const approvals = admin ? (raw.swapRequests ?? []).filter(r => r.status === 'awaiting_admin').length : 0;
  const drafts = admin ? raw.months.filter(m => m.status === 'draft' && m.generated && m.month >= today.slice(0, 7)) : [];
  const todo = pending + approvals + drafts.length;
  const dateLine = new Date(today + 'T12:00:00Z').toLocaleDateString(lang === 'en' ? 'en-GB' : 'he-IL', {weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC'});
  // The balance is a display projection, read where it is shown (never at startup).
  const [balance, setBalance] = useState<{revision: number; value: Balance | null} | null>(null);
  const revision = raw.revision, load = remote.balance;
  useEffect(() => {
    if (revision == null) return;
    let alive = true;
    load().then(value => {if (alive) setBalance({revision, value});}, () => {if (alive) setBalance({revision, value: null});});
    return () => {alive = false;};
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load is recreated each render; revision is the trigger.
  }, [revision]);
  const net = balance?.value?.net[me];
  return <div className="home">
    <header className="home-head">
      <p className="home-date">{dateLine}</p>
      <h1 className="home-greeting">{greeting(new Date(), lang)}{first ? `, ${first}` : ''}</h1>
    </header>
    <DutyCarousel duties={duties} today={today} lang={lang} t={t} name={name} onSwap={onSwap} onSchedule={onSchedule}/>
    {due && <Card inset>
      <ListRow lead={<span className="row-icon" data-tone="brand"><CalendarCheck/></span>} title={t(`Constraints for ${calendarMonthLabel(due.month, lang)}`, `אילוצים ל${calendarMonthLabel(due.month, lang)}`)}
        subtitle={t(`Due ${shortDate(due.deadline, lang)}`, `עד ${shortDate(due.deadline, lang)}`)} trail={<span className="row-action">{t('Enter now', 'להזין')}</span>} chevron onClick={() => onAvailability(due.month)}/>
    </Card>}
    {toAnswer.length > 0 && <>
      <SectionTitle>{t('Swaps to answer', 'החלפות לטיפול')}</SectionTitle>
      <div className="swap-cards">{toAnswer.map(r => <SwapCard key={r.id} r={r} swaps={swaps} remote={remote} lang={lang}/>)}</div>
    </>}
    {mine.length > 0 && <>
      <SectionTitle>{t('Your swaps', 'ההחלפות שלך')}</SectionTitle>
      <div className="swap-cards">{mine.map(r => <SwapCard key={r.id} r={r} swaps={swaps} remote={remote} lang={lang}/>)}</div>
    </>}
    <SectionTitle>{t('Your balance', 'המאזן שלך')}</SectionTitle>
    <Card className="balance-card">
      <span className="row-icon" data-tone="neutral"><Scale/></span>
      <div className="balance-body">
        {balance ? <>
          <strong className={net === undefined || net === 0 ? '' : net > 0 ? 'owed' : 'owes'}>{net === undefined ? '—' : <><CountUp value={Math.abs(net) / 2}/> <span className="balance-unit">{t('pts', 'נק׳')}</span></>}</strong>
          <span>{net === undefined || net === 0 ? t('All square', 'מאוזן') : net > 0 ? t('owed to you', 'חייבים לך') : t('you owe', 'את/ה חייב/ת')}</span>
        </> : <><Skeleton width={72} height={28}/><Skeleton width={110} height={14}/></>}
      </div>
      <Button variant="ghost" size="pill" onClick={onTeam}>{t('Details', 'פירוט')}</Button>
    </Card>
    {admin && todo > 0 && <>
      <SectionTitle>{t('To do', 'לטיפול')}</SectionTitle>
      <Card inset>
        {pending > 0 && <ListRow lead={<span className="row-icon" data-tone="warn"><Users/></span>} title={pending === 1 ? t('1 member to approve', 'חבר צוות אחד לאישור') : t(`${pending} members to approve`, `${pending} חברי צוות לאישור`)} chevron onClick={onTeam}/>}
        {approvals > 0 && <ListRow lead={<span className="row-icon" data-tone="info"><ShieldCheck/></span>} title={approvals === 1 ? t('1 swap to approve', 'החלפה אחת לאישור') : t(`${approvals} swaps to approve`, `${approvals} החלפות לאישור`)} chevron onClick={() => onSchedule((raw.swapRequests ?? []).find(r => r.status === 'awaiting_admin')!.month)}/>}
        {drafts.map(m => <ListRow key={m.month} lead={<span className="row-icon" data-tone="brand"><CalendarDays/></span>} title={t(`${calendarMonthLabel(m.month, lang)} is ready to publish`, `${calendarMonthLabel(m.month, lang)} מוכן לפרסום`)} chevron onClick={() => onSchedule(m.month)}/>)}
      </Card>
    </>}
  </div>;
}

function DutyCarousel({duties, today, lang, t, name, onSwap, onSchedule}: {duties: MyDuty[]; today: string; lang: Language; t: Translate; name: (id: string | null) => string; onSwap: (month: string, day: string) => void; onSchedule: (month: string) => void}) {
  const track = useRef<HTMLDivElement>(null), [page, setPage] = useState(0);
  const shown = duties.slice(0, 6);
  useEffect(() => {
    const node = track.current;
    if (!node) return;
    let frame = 0;
    const onScroll = () => {if (!frame) frame = requestAnimationFrame(() => {frame = 0; const width = node.clientWidth || 1; setPage(Math.round(Math.abs(node.scrollLeft) / width));});};
    node.addEventListener('scroll', onScroll, {passive: true});
    return () => {node.removeEventListener('scroll', onScroll); cancelAnimationFrame(frame);};
  }, [shown.length]);
  if (!shown.length) return <Card className="hero hero-empty">
    <EmptyState icon={<Inbox/>}>{t('No duties scheduled for you yet', 'עדיין אין לך תורנויות')}</EmptyState>
  </Card>;
  return <div className="hero-carousel">
    <div ref={track} className="hero-track" role="list" aria-label={t('Your next duties', 'התורנויות הבאות שלך')}>
      {shown.map((d, i) => {
        const when = dutyWhen(d.row.day, today, lang), weekend = d.row.end_day !== addDays(d.row.day, 1);
        const last = weekend ? shortDate(addDays(d.row.end_day, -1), lang) : null;
        const points = d.role === 'cover' ? 0 : d.row.points;
        const kind = d.role === 'cover' ? t('Emergency cover', 'כיסוי חירום') : d.kind === 'holiday' ? (d.row.title || t('Holiday', 'חג')) : d.kind === 'weekend' ? t('Weekend', 'סוף שבוע') : t('Weekday', 'יום חול');
        const swappable = d.role === 'primary' && (when.diff > 0 || d.row.day === today);
        return <article key={d.row.id} role="listitem" className="hero" data-when={when.diff <= 0 ? 'today' : when.diff === 1 ? 'tomorrow' : 'later'} aria-current={i === page ? 'true' : undefined}>
          <p className="hero-when">{when.label}</p>
          <h2 className="hero-title">{when.long}{last && <span className="hero-range"> – {last}</span>}</h2>
          <div className="hero-chips">
            <Chip tone="brand" className="hero-chip">{kind}</Chip>
            <Chip tone="brand" className="hero-chip">{points === 1 ? t('1 point', 'נקודה אחת') : t(`${points} points`, `${points} נקודות`)}</Chip>
            {d.role === 'primary' && d.row.secondary_id && <Chip tone="brand" className="hero-chip">{t('Cover', 'כיסוי')}: {name(d.row.secondary_id)}</Chip>}
            {d.role === 'cover' && d.row.primary_id && <Chip tone="brand" className="hero-chip">{t('For', 'עבור')} {name(d.row.primary_id)}</Chip>}
          </div>
          <div className="hero-actions">
            {swappable ? <Button className="hero-button" onClick={() => onSwap(d.month, d.row.day)}><ArrowLeftRight/>{t('Ask to swap', 'בקשת החלפה')}</Button>
              : <Button className="hero-button" variant="secondary" onClick={() => onSchedule(d.month)}><CalendarDays/>{t('Open month', 'פתיחת החודש')}</Button>}
          </div>
        </article>;
      })}
    </div>
    {shown.length > 1 && <div className="hero-dots" aria-hidden="true">{shown.map((d, i) => <span key={d.row.id} className={i === page ? 'on' : ''}/>)}</div>}
  </div>;
}

