'use client';
import type {ReactNode} from 'react';
import {Tabs, TabsList, TabsTrigger} from '@/components/ui/tabs';
import {MobileNavigation} from '@/components/rota/mobile-navigation';
import {navigationItems, NavigationLabel} from '@/components/rota/navigation-presentation';
import {Logo, Wordmark} from '@/components/brand/logo';
import {APP_NAME} from '@/lib/brand';
import {useMobileLayout} from '@/hooks/use-mobile-layout';
import type {Translate} from '@/components/rota/workspace-types';

/** The frame every signed-in screen shares (decision 2026-11-06): a floating glass tab bar on
 * phones, a sidebar on PC, one header with the activity bell and the avatar (Settings). */
export function AppShell({lang, t, tab, setTab, disabled = false, badge, bell, avatar, children, status}: {
  lang: 'en' | 'he'; t: Translate; tab: string; setTab: (tab: string) => void; disabled?: boolean;
  badge?: ReactNode; bell?: ReactNode; avatar: ReactNode; children: ReactNode; status?: ReactNode;
}) {
  const mobile = useMobileLayout(), rtl = lang === 'he';
  const items = navigationItems(t);
  return <Tabs value={tab} onValueChange={setTab} className="app-shell" dir={rtl ? 'rtl' : 'ltr'}>
    {!mobile && <aside className="side">
      <div className="side-brand"><Wordmark size={30}/></div>
      <TabsList variant="line" aria-label={t('Main navigation', 'ניווט ראשי')} className="side-nav">
        {items.map(item => <TabsTrigger key={item.value} value={item.value} aria-label={item.label} className="side-item"><NavigationLabel item={item}/></TabsTrigger>)}
      </TabsList>
      <div className="side-foot">{status}</div>
    </aside>}
    <div className="app-main">
      <header className="hdr">
        {mobile ? <span className="hdr-brand" aria-label={APP_NAME}><Logo size={30}/></span> : <span className="hdr-spacer"/>}
        <div className="hdr-actions">
          {badge}
          {bell}
          {avatar}
        </div>
      </header>
      <main className="main-wrap">{children}</main>
    </div>
    {mobile && <nav className="tabbar" aria-label={t('Main navigation', 'ניווט ראשי')}>
      <MobileNavigation value={tab} onChange={setTab} t={t} rtl={rtl} disabled={disabled}/>
    </nav>}
  </Tabs>;
}
