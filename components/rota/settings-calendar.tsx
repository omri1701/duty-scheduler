'use client';
import type {TeamWorkspace} from '@/hooks/use-team-workspace';

/** The settings screen's Calendar section (decision 2026-11-06). Empty for now: the
 * calendar-subscription work fills it, so keep it a self-contained slot. */
export function CalendarSettings({lang}: {remote: TeamWorkspace; lang: 'en' | 'he'}) {
  const t = (en: string, he: string) => lang === 'he' ? he : en;
  return <section className="settings-section settings-calendar" aria-labelledby="settings-calendar-title" data-settings-section="calendar">
    <h3 id="settings-calendar-title">{t('Calendar', 'לוח שנה')}</h3>
    <p className="muted-copy">{t('Nothing to set up here yet.', 'עדיין אין כאן מה להגדיר.')}</p>
  </section>;
}
