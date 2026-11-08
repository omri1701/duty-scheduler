import {Children,type ReactNode,type Ref,type ComponentProps} from 'react';
import {calendarOwnerMonth} from '@/lib/rota/calendar-dates';

export function CalendarDay({date,month,combined=false,weekend=false,special=false,className='',style,...props}:ComponentProps<'button'>&{
  date:string;month:string;combined?:boolean;weekend?:boolean;special?:boolean;
}) {
  return <button {...props} data-date={date} style={{...style,...(combined?{gridColumn:'span 2'}:{})}}
    className={['day-cell',calendarOwnerMonth(date)!==month?'outside':'',weekend?'weekend':'',combined?'combined-weekend':'',special?'special':'',className].join(' ')}/>;
}

export function CalendarAssignment({loading=false,className='',children,...props}:ComponentProps<'div'>&{loading?:boolean}) {
  return <div {...props} className={'assignment-chip '+(loading?'skel ': '')+className}>{loading?<span>—</span>:children}</div>;
}

// Public presentation only: both startup and the verified calendar use this
// exact surface. Identity, permissions, interactions and data stay with callers.
export function CalendarSurface({lang,children,gridRef,gridClassName='',toolbar,notices,dir}:{
  lang:'en'|'he';children:ReactNode;gridRef?:Ref<HTMLDivElement>;gridClassName?:string;toolbar?:ReactNode;notices?:ReactNode;
  /** The week's direction: left-to-right on PC even in Hebrew (decision 2026-10-31), the language's on phones. */
  dir:'ltr'|'rtl';
}) {
  return <section className="calendar-panel">
    {toolbar}
    <div className="calendar-week" dir={dir}>
      <CalendarWeekdays lang={lang}/>
      <div ref={gridRef} className={'calendar-grid '+gridClassName}>{children}</div>
    </div>
    {notices}
  </section>;
}

export function CalendarWeekdays({lang}:{lang:'en'|'he'}) {
  return <div className="calendar-weekdays">
    {(lang==='en'?['Sun','Mon','Tue','Wed','Thu','Fri','Sat']:['א׳','ב׳','ג׳','ד׳','ה׳','ו׳','ש׳']).map((day,i)=><span className={i>4?'weekend-label':''} key={day}>{day}</span>)}
  </div>;
}

export function CalendarDateLine({date,end,children,loading=false,today}:{date:string;end?:string;children?:ReactNode;loading?:boolean;today?:string}) {
  const number=(value:string)=>loading?<span className="skel skel-text">{Number(value.slice(-2))}</span>:<span className={value===today ? 'current-date' : undefined} aria-current={value===today ? 'date' : undefined}>{Number(value.slice(-2))}</span>;
  // Marks (lock, +extra) render only when present: an empty wrapper would shift the date numbers.
  const marks=Children.toArray(children);
  return <div className={end?'date-line weekend-dates':'date-line'}>
    <span className="day-number">{number(date)}</span>
    {end&&<span className="day-number weekend-end">{number(end)}</span>}
    {marks.length>0&&<span className="date-marks">{marks}</span>}
  </div>;
}
