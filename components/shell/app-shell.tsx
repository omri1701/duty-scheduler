'use client';
import {useState, type ReactNode} from 'react';
import {ChevronsLeft} from 'lucide-react';
import {useRefresh} from './refresh';
import {SIDEBAR_KEY} from '@/lib/theme/theme';
import {Tabs, TabsList, TabsTrigger} from '@/components/ui/tabs';
import {MobileNavigation} from '@/components/rota/mobile-navigation';
import {navigationItems, NavigationLabel} from '@/components/rota/navigation-presentation';
import {Logo, Wordmark} from '@/components/brand/logo';
import {APP_NAME} from '@/lib/brand';
import {useMobileLayout} from '@/hooks/use-mobile-layout';
import type {Translate} from '@/components/rota/workspace-types';

/** The frame every signed-in screen shares (decision 2026-11-06): a floating glass tab bar on
 * phones, a sidebar on PC, one header with the activity bell and the avatar (Settings). */
export function AppShell({lang, t, tab, setTab, disabled = false, badge, bell, avatar, children, status, onRefresh}: {
  lang: 'en' | 'he'; t: Translate; tab: string; setTab: (tab: string) => void; disabled?: boolean; onRefresh: () => Promise<unknown>;
  badge?: ReactNode; bell?: ReactNode; avatar: ReactNode; children: ReactNode; status?: ReactNode;
}) {
  const mobile = useMobileLayout(), rtl = lang === 'he';
  const items = navigationItems(t);
  // Pull down on a phone, or tap the logo anywhere, to reload the team.
  const {indicator, refresh} = useRefresh(onRefresh, {pull: mobile, label: t('Refreshing…', 'מרענן…')});
  // Wide screens can fold the sidebar to icons; the choice is set on <html> before the first paint.
  const [collapsed, setCollapsed] = useState(() => typeof document !== 'undefined' && document.documentElement.dataset.sidebar === 'collapsed');
  const toggleSidebar = () => {
    const next = !collapsed;
    setCollapsed(next);
    document.documentElement.dataset.sidebar = next ? 'collapsed' : 'open';
    try {localStorage.setItem(SIDEBAR_KEY, next ? 'collapsed' : 'open');} catch {}
  };
  return <Tabs value={tab} onValueChange={setTab} className="app-shell" dir={rtl ? 'rtl' : 'ltr'}>
    {!mobile && <aside className="side">
      <button type="button" className="side-brand brand-button" onClick={() => void refresh()} aria-label={t('Refresh', 'רענון')} title={t('Refresh', 'רענון')}><Wordmark size={30}/></button>
      <TabsList variant="line" aria-label={t('Main navigation', 'ניווט ראשי')} className="side-nav">
        {items.map(item => <TabsTrigger key={item.value} value={item.value} aria-label={item.label} className="side-item"><NavigationLabel item={item}/></TabsTrigger>)}
      </TabsList>
      <div className="side-foot">
        {status}
        <button type="button" className="side-toggle" onClick={toggleSidebar} aria-expanded={!collapsed}
          aria-label={collapsed ? t('Expand sidebar', 'הרחבת סרגל הצד') : t('Collapse sidebar', 'כיווץ סרגל הצד')}>
          <ChevronsLeft aria-hidden="true"/><span className="navigation-label">{collapsed ? t('Expand', 'הרחבה') : t('Collapse', 'כיווץ')}</span>
        </button>
      </div>
    </aside>}
    <div className="app-main">
      <header className="hdr">
        {mobile ? <button type="button" className="hdr-brand brand-button" onClick={() => void refresh()} aria-label={`${APP_NAME} · ${t('Refresh', 'רענון')}`}><Logo size={30}/></button> : <span className="hdr-spacer"/>}
        <div className="hdr-actions">
          {badge}
          {bell}
          {avatar}
        </div>
      </header>
      {indicator}
      <main className="main-wrap">{children}</main>
    </div>
    {mobile && <nav className="tabbar" aria-label={t('Main navigation', 'ניווט ראשי')}>
      <MobileNavigation value={tab} onChange={setTab} t={t} rtl={rtl} disabled={disabled}/>
    </nav>}
  </Tabs>;
}
