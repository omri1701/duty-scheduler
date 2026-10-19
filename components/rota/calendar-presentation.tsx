import type {ReactNode,Ref,ComponentProps} from 'react';
import type {Translate} from './workspace-types';
import {calendarOwnerMonth} from '@/lib/rota/calendar-dates';

export function CalendarDay({date,month,combined=false,weekend=false,special=false,className='',style,...props}:ComponentProps<'button'>&{
  date:string;month:string;combined?:boolean;weekend?:boolean;special?:boolean;
}) {
  return <button {...props} data-date={date} style={{...style,...(combined?{gridColumn:'span 2'}:{})}}
    className={['day-cell',calendarOwnerMonth(date)!==month?'outside':'',weekend?'weekend':'',combined?'combined-weekend':'',special?'special':'',className].join(' ')}/>;
}

export function CalendarAssignment({loading=false,className='',children,...props}:ComponentProps<'div'>&{loading?:boolean}) {
  return <div {...props} className={'assignment-chip '+(loading?'skeleton-content ': '')+className}>{loading?<span>—</span>:children}</div>;
}

export function CalendarFilters({t,value='team',onChange,loading=false,children}:{
  t:Translate;value?:string;onChange?:(value:string)=>void;loading?:boolean;children?:ReactNode;
}) {
  return <div className="segmented">
    {(['team','me'] as const).map(view=><button key={view} disabled={loading} aria-pressed={value===view} className={[value===view?'selected':'',loading?'skeleton-content':''].join(' ')} onClick={onChange?()=>onChange(view):undefined}>
      {view==='team'?t('Whole team','כל הצוות'):t('My duties','התורנויות שלי')}
    </button>)}
    {children}
  </div>;
}

// Public presentation only: both startup and the verified calendar use this
// exact surface. Identity, permissions, interactions and data stay with callers.
export function CalendarSurface({lang,toolbar,beforeGrid,children,footer,notices,gridRef,gridClassName=''}:{
  lang:'en'|'he';toolbar:ReactNode;beforeGrid?:ReactNode;children:ReactNode;
  footer:ReactNode;notices?:ReactNode;gridRef?:Ref<HTMLDivElement>;gridClassName?:string;
}) {
  return <section className="calendar-panel">
    <div className="calendar-top">{toolbar}</div>
    {beforeGrid}
    <CalendarWeekdays lang={lang}/>
    <div ref={gridRef} className={'calendar-grid '+gridClassName}>{children}</div>
    <div className="calendar-footer">{footer}</div>
    {notices}
  </section>;
}

export function CalendarWeekdays({lang}:{lang:'en'|'he'}) {
  return <div className="calendar-weekdays">
    {(lang==='en'?['Sun','Mon','Tue','Wed','Thu','Fri','Sat']:['א׳','ב׳','ג׳','ד׳','ה׳','ו׳','ש׳']).map((day,i)=><span className={i>4?'weekend-label':''} key={day}>{day}</span>)}
  </div>;
}

export function CalendarDateLine({date,end,children,loading=false,today}:{date:string;end?:string;children?:ReactNode;loading?:boolean;today?:string}) {
  const number=(value:string)=>loading?<span className="skeleton-content">{Number(value.slice(-2))}</span>:<span className={value===today ? 'current-date' : undefined} aria-current={value===today ? 'date' : undefined}>{Number(value.slice(-2))}</span>;
  return <div className={end?'date-line weekend-dates':'date-line'}>
    <span className="day-number">{number(date)}</span>
    {end&&<span className="day-number weekend-end">{number(end)}</span>}
    {children}
  </div>;
}
