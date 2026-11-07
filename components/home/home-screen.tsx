'use client';
import {useEffect, useRef, useState} from 'react';
import {ArrowLeftRight, CalendarCheck, CalendarDays, ChevronLeft, ChevronRight, Inbox, Scale, ShieldCheck, Users} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Card, SectionTitle} from '@/components/ui/card';
import {ListRow} from '@/components/ui/list-row';
import {Chip} from '@/components/ui/chip';
import {CountUp} from '@/components/ui/count-up';
import {EmptyState} from '@/components/ui/empty-state';
import {Skeleton} from '@/components/ui/skeleton';
import type {TeamWorkspace} from '@/hooks/use-team-workspace';
import {useBalance} from '@/hooks/use-balance';
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
  const raw = remote.snapshot!, me = remote.memberId, admin = remote.isAdmin;
  const name = (id: string | null) => raw.members.find(m => m.id === id)?.name ?? '';
  const first = (remote.me?.name ?? '').trim().split(/\s+/)[0] || '';
  const duties = myUpcomingDuties(raw, me, today);
  const due = constraintsDue(raw, today, admin);
  // Requests that wait for the member (or the admin), then the member's own open ones.
  const toAnswer = swaps.requests.filter(r => swapNeedsAction(r, me, admin, swaps.temporary));
  const mine = swaps.requests.filter(r => !toAnswer.includes(r) && ['awaiting_engineer', 'awaiting_admin'].includes(r.status));
  // An answered request flies off before it leaves the list.
  const answerCards = useLeaving(toAnswer), mineCards = useLeaving(mine);
  const pending = admin ? raw.members.filter(m => m.status === 'pending').length : 0;
  const approvals = admin ? (raw.swapRequests ?? []).filter(r => r.status === 'awaiting_admin').length : 0;
  const drafts = admin ? raw.months.filter(m => m.status === 'draft' && m.generated && m.month >= today.slice(0, 7)) : [];
  const todo = pending + approvals + drafts.length;
  const dateLine = new Date(today + 'T12:00:00Z').toLocaleDateString(lang === 'en' ? 'en-GB' : 'he-IL', {weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC'});
  // The balance is a display projection, read where it is shown (never at startup).
  // Shown at once from the last read while a newer revision loads (hooks/use-balance.ts).
  const balance = useBalance(remote);
  const net = balance?.net[me];
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
    {answerCards.length > 0 && <>
      <SectionTitle>{t('Swaps to answer', 'החלפות לטיפול')}</SectionTitle>
      <div className="swap-cards">{answerCards.map(({item: r, leaving}) => <div key={r.id} className="swap-slot" data-leaving={leaving || undefined} inert={leaving || undefined}>
        <SwapCard r={r} swaps={swaps} remote={remote} lang={lang}/></div>)}</div>
    </>}
    {mineCards.length > 0 && <>
      <SectionTitle>{t('Your swaps', 'ההחלפות שלך')}</SectionTitle>
      <div className="swap-cards">{mineCards.map(({item: r, leaving}) => <div key={r.id} className="swap-slot" data-leaving={leaving || undefined} inert={leaving || undefined}>
        <SwapCard r={r} swaps={swaps} remote={remote} lang={lang}/></div>)}</div>
    </>}
    <SectionTitle>{t('Your balance', 'המאזן שלך')}</SectionTitle>
    <Card className="balance-card">
      <span className="row-icon" data-tone="neutral"><Scale/></span>
      <div className="balance-body">
        {balance !== undefined ? <>
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
    // One card step is a card plus the gap (RTL tracks scroll to negative offsets).
    const step = () => {const [a, b] = node.children as unknown as HTMLElement[]; return (a && b ? Math.abs(b.offsetLeft - a.offsetLeft) : node.clientWidth) || 1;};
    const onScroll = () => {if (!frame) frame = requestAnimationFrame(() => {frame = 0; setPage(Math.round(Math.abs(node.scrollLeft) / step()));});};
    node.addEventListener('scroll', onScroll, {passive: true});
    return () => {node.removeEventListener('scroll', onScroll); cancelAnimationFrame(frame);};
  }, [shown.length]);
  // Dots, arrows and the Up next cards bring a duty into view; the track's own snap does the rest.
  const go = (index: number) => {
    const node = track.current, next = Math.max(0, Math.min(shown.length - 1, index));
    const card = node?.children[next] as HTMLElement | undefined;
    if (!node || !card) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    node.scrollTo({left: card.offsetLeft - (node.firstElementChild as HTMLElement).offsetLeft, behavior: reduce ? 'auto' : 'smooth'});
    setPage(next);
  };
  const rtl = lang === 'he', Prev = rtl ? ChevronRight : ChevronLeft, Next = rtl ? ChevronLeft : ChevronRight;
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
    {shown.length > 1 && <div className="hero-nav">
      <Button variant="ghost" size="icon-sm" className="hero-arrow" aria-label={t('Previous duty', 'התורנות הקודמת')} disabled={page === 0} onClick={() => go(page - 1)}><Prev/></Button>
      <div className="hero-dots">{shown.map((d, i) => <button key={d.row.id} type="button" className={i === page ? 'on' : ''} aria-current={i === page ? 'true' : undefined}
        aria-label={t(`Duty ${i + 1} of ${shown.length}`, `תורנות ${i + 1} מתוך ${shown.length}`)} onClick={() => go(i)}><span/></button>)}</div>
      <Button variant="ghost" size="icon-sm" className="hero-arrow" aria-label={t('Next duty', 'התורנות הבאה')} disabled={page === shown.length - 1} onClick={() => go(page + 1)}><Next/></Button>
    </div>}
  </div>;
}


/** Keeps items that just left the list for one exit animation (instant under reduced motion). */
function useLeaving<T extends {id: string}>(items: T[], ms = 320) {
  const [prev, setPrev] = useState(items), [gone, setGone] = useState<{item: T; at: number}[]>([]);
  if (prev.length !== items.length || prev.some((p, i) => p !== items[i])) {
    const removed = prev.flatMap((p, at) => items.some(n => n.id === p.id) ? [] : [{item: p, at}]);
    setPrev(items);
    if (removed.length) setGone(g => [...g.filter(x => !items.some(n => n.id === x.item.id) && !removed.some(r => r.item.id === x.item.id)), ...removed]);
  }
  useEffect(() => {
    if (!gone.length) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const timer = window.setTimeout(() => setGone([]), reduce ? 0 : ms);
    return () => window.clearTimeout(timer);
  }, [gone, ms]);
  const shown: {item: T; leaving: boolean}[] = items.map(item => ({item, leaving: false}));
  for (const {item, at} of [...gone].sort((a, b) => a.at - b.at)) if (!items.some(n => n.id === item.id)) shown.splice(Math.min(at, shown.length), 0, {item, leaving: true});
  return shown;
}
