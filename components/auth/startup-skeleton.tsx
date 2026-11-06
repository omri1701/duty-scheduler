'use client';
import {Logo, Wordmark} from '@/components/brand/logo';
import {LoadingNavigation, navigationItems, NavigationLabel} from '@/components/rota/navigation-presentation';
import {EnvironmentBadge, InspectionWarning} from '@/components/environment-indicator';
import {Skeleton} from '@/components/ui/skeleton';
import {Card} from '@/components/ui/card';
import {useMobileLayout} from '@/hooks/use-mobile-layout';
import type {Environment} from '@/lib/supabase/environment';
import {APP_NAME} from '@/lib/brand';

// Only public inputs: the shell, a Home placeholder with the final sizes reserved. No identity,
// role hint or snapshot, so loaded content never shifts the page.
export function StartupSkeleton({lang, environment}: {lang: 'en' | 'he'; environment: Environment | null}) {
  const t = (en: string, he: string) => lang === 'en' ? en : he;
  const mobile = useMobileLayout(), rtl = lang === 'he';
  return <main className="app-shell startup-skeleton" dir={rtl ? 'rtl' : 'ltr'} aria-busy="true">
    <p className="sr-only" role="status">{t('Loading…', 'טוען…')}</p>
    <div inert aria-hidden="true" className="app-shell-inner">
      {!mobile && <aside className="side">
        <div className="side-brand"><Wordmark size={30}/></div>
        <div className="side-nav" data-slot="tabs-list">
          {navigationItems(t).map(item => <button disabled key={item.value} className="side-item" data-slot="tabs-trigger" data-state={item.value === 'home' ? 'active' : 'inactive'}><NavigationLabel item={item}/></button>)}
        </div>
      </aside>}
      <div className="app-main">
        <header className="hdr">
          {mobile ? <span className="hdr-brand" aria-label={APP_NAME}><Logo size={30}/></span> : <span className="hdr-spacer"/>}
          <div className="hdr-actions"><EnvironmentBadge environment={environment}/><Skeleton width={44} height={44} round/><Skeleton width={44} height={44} round/></div>
        </header>
        <div className="main-wrap">
          <InspectionWarning environment={environment} lang={lang}/>
          <div className="home">
            <header className="home-head"><p className="home-date"><Skeleton width={160} height={14}/></p><h1 className="home-greeting"><Skeleton width={220} height={26}/></h1></header>
            <Card className="hero hero-skeleton"><Skeleton width={90} height={14}/><Skeleton width={200} height={28}/><Skeleton width={240} height={24}/><Skeleton width={150} height={44}/></Card>
            <Skeleton width={120} height={12}/>
            <Card className="balance-card"><Skeleton width={40} height={40} round/><div className="balance-body"><Skeleton width={72} height={28}/><Skeleton width={110} height={14}/></div></Card>
          </div>
        </div>
      </div>
      {mobile && <nav className="tabbar"><LoadingNavigation t={t} rtl={rtl}/></nav>}
    </div>
  </main>;
}
