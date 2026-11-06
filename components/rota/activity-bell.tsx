'use client';
import {useMemo, useState} from 'react';
import {ArrowLeftRight, Bell, CalendarDays, Inbox, PenLine, UserPlus} from 'lucide-react';
import {Popover, PopoverContent, PopoverTrigger} from '@/components/ui/popover';
import {EmptyState} from '@/components/ui/empty-state';
import type {Snapshot} from '@/lib/supabase/snapshot';
import {calendarMonthLabel} from '@/lib/rota/calendar-dates';
import {shortDate} from '@/lib/date-format';
import type {Language, Translate} from './workspace-types';

type Event = {id: string; at: string; icon: 'published' | 'edited' | 'swap' | 'member'; text: string; month?: string};
const SEEN_KEY = 'duty-activity-seen';

/** Recent events, derived from the snapshot (decision 2026-11-06): publications, new versions
 * (published duty edits and swaps), answered swap requests and, for admins, sign-ups. */
export function recentActivity(raw: Snapshot, me: string, admin: boolean, lang: Language): Event[] {
  const t: Translate = (en, he) => lang === 'he' ? he : en;
  const name = (id: string | null) => raw.members.find(m => m.id === id)?.name ?? t('Someone', 'מישהו');
  const month = (m: string) => calendarMonthLabel(m, lang);
  const events: Event[] = [];
  for (const p of raw.publications) {
    const first = !raw.publications.some(o => o.month === p.month && o.version < p.version);
    events.push(first
      ? {id: `pub-${p.id}`, at: p.published_at, icon: 'published', month: p.month, text: t(`${month(p.month)} was published by ${name(p.published_by)}`, `${month(p.month)} פורסם על ידי ${name(p.published_by)}`)}
      : {id: `ver-${p.id}`, at: p.published_at, icon: 'edited', month: p.month, text: t(`${month(p.month)} changed · version ${p.version}`, `${month(p.month)} השתנה · גרסה ${p.version}`)});
  }
  for (const r of raw.swapRequests ?? []) {
    const involved = [r.requester_id, r.other_id, r.proposed_by].includes(me) || admin;
    if (!involved) continue;
    const pair = `${name(r.requester_id)} ↔ ${name(r.other_id)} · ${shortDate(r.from_day, lang)} ↔ ${shortDate(r.to_day, lang)}`;
    if (r.resolved_at) {
      const what = {approved: t('approved', 'אושרה'), declined: t('declined', 'סורבה'), rejected: t('rejected', 'נדחתה'), cancelled: t('cancelled', 'בוטלה'), invalidated: t('no longer applies', 'כבר לא תקפה'), awaiting_admin: t('accepted', 'התקבלה'), awaiting_engineer: t('updated', 'עודכנה')}[r.status];
      events.push({id: `swap-${r.id}-done`, at: r.resolved_at, icon: 'swap', month: r.month, text: t(`Swap ${what}: ${pair}`, `החלפה ${what}: ${pair}`)});
    } else if (r.accepted_at) events.push({id: `swap-${r.id}-ok`, at: r.accepted_at, icon: 'swap', month: r.month, text: t(`Swap accepted, waiting for an admin: ${pair}`, `ההחלפה התקבלה וממתינה למנהל: ${pair}`)});
    events.push({id: `swap-${r.id}`, at: r.created_at, icon: 'swap', month: r.month, text: r.proposed_by ? t(`${name(r.proposed_by)} proposed a swap: ${pair}`, `${name(r.proposed_by)} הציע/ה החלפה: ${pair}`) : t(`${name(r.requester_id)} asked to swap: ${pair}`, `${name(r.requester_id)} ביקש/ה החלפה: ${pair}`)});
  }
  if (admin) for (const m of raw.members.filter(m => m.status === 'pending')) events.push({id: `member-${m.id}`, at: '9999', icon: 'member', text: t(`${m.name} is waiting for approval`, `${m.name} ממתין/ה לאישור`)});
  return events.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 12);
}

function readSeen() {try {return localStorage.getItem(SEEN_KEY) ?? '';} catch {return '';}}

export function ActivityBell({raw, me, admin, lang, onOpenMonth}: {raw: Snapshot; me: string; admin: boolean; lang: Language; onOpenMonth: (month: string) => void}) {
  const t: Translate = (en, he) => lang === 'he' ? he : en;
  const events = useMemo(() => recentActivity(raw, me, admin, lang), [raw, me, admin, lang]);
  const [seen, setSeen] = useState(readSeen), [open, setOpen] = useState(false);
  const unread = events.filter(e => e.at > seen).length;
  const when = (at: string) => at === '9999' ? t('Now', 'עכשיו') : new Date(at).toLocaleDateString(lang === 'en' ? 'en-GB' : 'he-IL', {day: 'numeric', month: 'short', timeZone: 'Asia/Jerusalem'});
  const icons = {published: <CalendarDays/>, edited: <PenLine/>, swap: <ArrowLeftRight/>, member: <UserPlus/>};
  return <Popover open={open} onOpenChange={next => {
    setOpen(next);
    if (next && events[0]) {const latest = events[0].at === '9999' ? new Date().toISOString() : events[0].at; setSeen(latest); try {localStorage.setItem(SEEN_KEY, latest);} catch {}}
  }}>
    <PopoverTrigger asChild>
      <button type="button" className="icon-button bell" aria-label={unread ? t(`Activity · ${unread} new`, `פעילות · ${unread} חדשות`) : t('Activity', 'פעילות')} data-bell>
        <Bell aria-hidden="true"/>
        {unread > 0 && <span className="bell-badge" aria-hidden="true">{unread > 9 ? '9+' : unread}</span>}
      </button>
    </PopoverTrigger>
    <PopoverContent className="bell-menu" align="end" sideOffset={8} collisionPadding={12} dir={lang === 'he' ? 'rtl' : 'ltr'}>
      <h3 className="bell-title">{t('Activity', 'פעילות')}</h3>
      {events.length ? <ul className="bell-list">{events.map(e => <li key={e.id}>
        <button type="button" className="bell-item" disabled={!e.month} onClick={() => {if (e.month) {onOpenMonth(e.month); setOpen(false);}}}>
          <span className="row-icon" data-tone={e.icon === 'member' ? 'warn' : e.icon === 'swap' ? 'info' : 'brand'}>{icons[e.icon]}</span>
          <span className="bell-text">{e.text}</span>
          <time className="bell-when">{when(e.at)}</time>
        </button>
      </li>)}</ul> : <EmptyState icon={<Inbox/>}>{t('Nothing yet', 'אין פעילות עדיין')}</EmptyState>}
    </PopoverContent>
  </Popover>;
}
