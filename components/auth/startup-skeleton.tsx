import {CalendarDays, SlidersHorizontal, Users} from 'lucide-react';

// Public, static geometry only. This component never receives an identity or snapshot.
export function StartupSkeleton({lang}: {lang: 'en' | 'he'}) {
  const t = (en: string, he: string) => lang === 'en' ? en : he;
  return <main className="app-shell startup-skeleton" dir={lang === 'he' ? 'rtl' : 'ltr'} aria-busy="true">
    <p className="sr-only" role="status">{t('Loading calendar…', 'טוען את הלוח…')}</p>
    <div inert aria-hidden="true">
      <header className="topbar">
        <span className="brand"><span className="brand-symbol">d<span>·</span></span> duty</span>
        <div className="top-actions"><span className="skeleton-bar skeleton-control"/><span className="skeleton-avatar"/></div>
      </header>
      <div className="main-wrap">
        <div className="workspace-status"><span className="skeleton-bar skeleton-copy"/><span className="skeleton-control"/></div>
        <div className="main-tabs skeleton-tabs">
          <div className="nav-row">
            <div className="mobile-navigation">
              <div className="skeleton-nav-list" data-slot="tabs-list">
                <span data-slot="tabs-trigger" data-state="active"><CalendarDays/>{t('Schedule', 'לוח תורנויות')}</span>
                <span data-slot="tabs-trigger"><SlidersHorizontal/>{t('Availability', 'אילוצים')}</span>
                <span data-slot="tabs-trigger"><Users/>{t('Team', 'צוות')}</span>
              </div>
            </div>
          </div>
          <div className="month-toolbar">
            <div className="month-title"><span className="skeleton-control"/><span className="skeleton-bar skeleton-month"/><span className="skeleton-control"/><span className="skeleton-bar skeleton-badge"/></div>
            <div className="toolbar-actions"><span className="skeleton-bar skeleton-action"/><span className="skeleton-bar skeleton-action"/></div>
          </div>
          <div className="workspace-grid">
            <section className="calendar-panel">
              <div className="calendar-top"><span className="skeleton-bar skeleton-filter"/></div>
              <div className="calendar-weekdays">
                {(lang === 'en' ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] : ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳']).map((day, i) => <span key={day} className={i > 4 ? 'weekend-label' : undefined}>{day}</span>)}
              </div>
              <div className="skeleton-grid">
                {Array.from({length: 30}, (_, i) => <div className={'skeleton-day' + (i % 6 === 5 ? ' skeleton-weekend' : '')} key={i}>
                  <span className="skeleton-bar skeleton-date"/><span className="skeleton-bar skeleton-assignment"/>
                </div>)}
              </div>
              <div className="calendar-footer"><span className="skeleton-bar skeleton-copy"/></div>
            </section>
            <aside className="side-panel">
              <div className="coverage-card"><span className="skeleton-bar skeleton-copy"/><span className="skeleton-bar skeleton-total"/><span className="skeleton-bar"/></div>
              <div className="fairness-card"><span className="skeleton-bar skeleton-copy"/>{Array.from({length: 4}, (_, i) => <span className="skeleton-bar skeleton-summary" key={i}/>)}</div>
            </aside>
          </div>
        </div>
      </div>
    </div>
  </main>;
}
