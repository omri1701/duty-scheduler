'use client';
import {useSyncExternalStore} from 'react';
import {CalendarDays,SlidersHorizontal,Users,Globe,Info,ArrowRight} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {tabsListVariants,tabsTriggerStyles} from '@/components/ui/tabs-styles';
import {EnvironmentBadge,InspectionWarning} from '@/components/environment-indicator';
import type {Environment} from '@/lib/supabase/environment';
import {addDays,initialCalendarMonth,publicCalendarCells,calendarMonthLabel} from '@/lib/rota/calendar-dates';
import {CalendarDateLine,CalendarSurface} from '@/components/rota/calendar-presentation';
import {MonthHeading} from '@/components/rota/month-heading';
import {BrandContent,WorkspaceHeader,WorkspaceFooter} from '@/components/rota/workspace-frame';

const subscribeToClock=()=>()=>{};
const noServerMonth=()=>'';

// Only public date/configuration inputs. No identity, role hint or snapshot.
export function StartupSkeleton({lang,environment}:{lang:'en'|'he';environment:Environment|null}) {
  const t=(en:string,he:string)=>lang==='en'?en:he;
  // Static HTML may outlive its build month. Resolve public dates before the
  // hydrated render, without fetching or importing workspace logic.
  const month=useSyncExternalStore(subscribeToClock,initialCalendarMonth,noServerMonth);
  return <main className="app-shell startup-skeleton" dir={lang==='he'?'rtl':'ltr'} aria-busy="true">
    <p className="sr-only" role="status">{t('Loading calendar…','טוען את הלוח…')}</p>
    <div inert aria-hidden="true">
      <WorkspaceHeader brand={<span className="brand"><BrandContent t={t}/></span>}>
        {environment?.badge?<EnvironmentBadge environment={environment}/>:<span className="demo-badge skeleton-content">{t('TEAM WORKSPACE','סביבת הצוות')}</span>}
        <Button variant="ghost" size="icon" disabled className="skeleton-content"><Globe/></Button>
        <button disabled className="avatar startup-avatar skeleton-content"/>
        <Button variant="ghost" size="sm" disabled className="skeleton-content">{t('Sign out','יציאה')}</Button>
      </WorkspaceHeader>
      <div className="main-wrap">
        <div className="workspace-status"><span className="skeleton-content">{t('Shared team schedule','לוח תורנויות משותף')}</span><Button variant="ghost" size="sm" disabled className="skeleton-content"><Info/>{t('Help','עזרה')}</Button></div>
        <InspectionWarning environment={environment} lang={lang}/>
        <div className="workspace-controls">
          <div className="main-tabs group/tabs flex flex-col gap-2 skeleton-tabs" data-orientation="horizontal">
            <div className="nav-row">
              <div className="mobile-navigation">
                <div className={tabsListVariants({variant:'line'})} data-slot="tabs-list" data-variant="line">
                  {[[CalendarDays,t('Schedule','לוח תורנויות')],[SlidersHorizontal,t('Availability','אילוצים')],[Users,t('Team & fairness','צוות והוגנות')]].map(([Icon,label],i)=>{
                    const Glyph=Icon as typeof CalendarDays;
                    return <button disabled key={i} className={tabsTriggerStyles} data-slot="tabs-trigger" data-state={i===0?'active':'inactive'}><Glyph/><span className={i===2?'skeleton-team-label':undefined}>{label as string}</span>{i===2&&<span className="skeleton-phone-team-label">{t('Team','צוות')}</span>}</button>;
                  })}
                </div>
              </div>
              <span className="time-zone">09:00 → 09:00 · {t('Israel time','שעון ישראל')}</span>
            </div>
            <div className="month-toolbar"><MonthHeading label={month?calendarMonthLabel(month,lang):''} t={t} loading/><div className="toolbar-actions"/></div>
            <div className="workspace-grid">
              <CalendarSurface lang={lang} gridClassName="skeleton-grid" footer={<> <span><span className="legend-box"/>{t('Weekend = 1 point · Split = ½ each','סופ״ש = נקודה · חצי לכל יום בפיצול')}</span><span><span className="legend-box special-legend"/>{t('Special block','מקטע מיוחד')}</span><span className="skeleton-content">{t('Tap to edit · Hold & drag to swap','לחצו לעריכה · לחיצה ארוכה וגרירה להחלפה')}</span> </>} toolbar={<><div className="segmented"><button disabled className="selected skeleton-content">{t('Whole team','כל הצוות')}</button><button disabled className="skeleton-content">{t('My duties','התורנויות שלי')}</button></div></>}>
                  {month&&publicCalendarCells(month).map(({date,period,combined})=><button disabled key={date} data-date={date} className={['day-cell',!date.startsWith(month)?'outside':'',combined?'weekend combined-weekend':''].join(' ')} style={combined?{gridColumn:'span 2'}:undefined}>
                    <CalendarDateLine date={date} end={combined?addDays(period!.end,-1):undefined} loading/>
                    {(date.startsWith(month)||combined)&&<div className="assignment-chip skeleton-content"><span>—</span></div>}
                  </button>)}

              </CalendarSurface>
              <aside className="side-panel">
                <div className="coverage-card"><div className="eyebrow">{t('THIS MONTH','החודש')}</div><div className="coverage-number skeleton-content">—<span>/ —</span></div><div>{t('duties covered','תורנויות משובצות')}</div><div className="coverage-track"><span className="skeleton-content"/></div><div className="coverage-bottom"><span className="skeleton-content">——</span><span className="skeleton-content">——</span></div></div>
                <div className="fairness-card"><div className="panel-title"><h3>{t('The balance','האיזון')}</h3><span>{t('POINTS','נקודות')}</span></div><div className="balance-list"><div className="balance-row"><span className="avatar small skeleton-content"/><div className="balance-person"><span className="skeleton-content">——</span><div className="balance-track"/></div></div></div><Button variant="ghost" disabled className="full-width skeleton-content">{t('Manage team & order','ניהול הצוות והסדר')}<ArrowRight/></Button></div>
                <div className="deadline-card"><CalendarDays size={18}/><div><strong>{t('Constraints due','מועד אחרון לאילוצים')}</strong><p className="skeleton-content">—— · ————</p></div></div>
              </aside>
            </div>
          </div>
        </div>
        <WorkspaceFooter t={t} loading/>
      </div>
    </div>
  </main>;
}
