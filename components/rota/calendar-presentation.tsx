import type {ReactNode,Ref} from 'react';

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

export function CalendarDateLine({date,end,children,loading=false}:{date:string;end?:string;children?:ReactNode;loading?:boolean}) {
  const number=(value:string)=>loading?<span className="skeleton-content">{Number(value.slice(-2))}</span>:Number(value.slice(-2));
  return <div className={end?'date-line weekend-dates':'date-line'}>
    <span className="day-number">{number(date)}</span>
    {end&&<span className="day-number weekend-end">{number(end)}</span>}
    {children}
  </div>;
}
