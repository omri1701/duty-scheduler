'use client';
import type {TeamWorkspace} from '@/hooks/use-team-workspace';
import {CalendarSubscription} from '@/components/rota/calendar-subscription';

/** The settings screen's Calendar section (decision 2026-11-06): the personal calendar
 * subscription, for approved active members only (the feed RPCs refuse anyone else). */
export function CalendarSettings({remote, lang}: {remote: TeamWorkspace; lang: 'en' | 'he'}) {
  const t = (en: string, he: string) => lang === 'he' ? he : en;
  const me = remote.me;
  return <section className="settings-section settings-calendar" aria-labelledby="settings-calendar-title" data-settings-section="calendar">
    <h3 id="settings-calendar-title">{t('Calendar', 'לוח שנה')}</h3>
    {me && me.status === 'approved' && me.active
      ? <CalendarSubscription lang={lang} memberId={me.id} readOnly={remote.readOnly}/>
      : <p className="muted-copy">{t('Available once an admin approves you.', 'יהיה זמין אחרי שמנהל יאשר אותך.')}</p>}
  </section>;
}
