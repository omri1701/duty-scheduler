'use client';
import {useSyncExternalStore} from 'react';
import {CalendarDays,Globe,Info,ArrowRight} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {LoadingNavigation} from '@/components/rota/navigation-presentation';
import {EnvironmentBadge,InspectionWarning} from '@/components/environment-indicator';
import type {Environment} from '@/lib/supabase/environment';
import {addDays,initialCalendarMonth,publicCalendarCells,calendarMonthLabel} from '@/lib/rota/calendar-dates';
import {CalendarDateLine,CalendarSurface,CalendarDay,CalendarAssignment,CalendarFilters} from '@/components/rota/calendar-presentation';
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
              <LoadingNavigation t={t} rtl={lang==='he'}/>
              <span className="time-zone">09:00 → 09:00 · {t('Israel time','שעון ישראל')}</span>
            </div>
            <div className="month-toolbar"><MonthHeading label={month?calendarMonthLabel(month,lang):''} t={t} loading/><div className="toolbar-actions"/></div>
            <div className="workspace-grid">
              <CalendarSurface lang={lang} gridClassName="skeleton-grid" footer={<> <span><span className="legend-box"/>{t('Weekend = 1 point · Split = ½ each','סופ״ש = נקודה · חצי לכל יום בפיצול')}</span><span><span className="legend-box special-legend"/>{t('Special block','מקטע מיוחד')}</span><span className="skeleton-content">{t('Tap to edit · Hold & drag to swap','לחצו לעריכה · לחיצה ארוכה וגרירה להחלפה')}</span> </>} toolbar={<CalendarFilters t={t} loading/>}>

                  {month&&publicCalendarCells(month).map(({date,period,combined})=><CalendarDay disabled key={date} date={date} month={month} combined={combined} weekend={combined}>

                    <CalendarDateLine date={date} end={combined?addDays(period!.end,-1):undefined} loading/>
                    {(date.startsWith(month)||combined)&&<CalendarAssignment loading/>}
                  </CalendarDay>)}

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
