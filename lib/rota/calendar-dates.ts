// Public date arithmetic: no scheduler, identity, storage or workspace imports.
export const addDays = (s:string,n:number) => {const d=new Date(s+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)};
export const dayOf = (s:string) => new Date(s+'T12:00:00Z').getUTCDay();
export const monthNext = (m:string,n=1) => {const d=new Date(m+'-15T12:00:00Z');d.setUTCMonth(d.getUTCMonth()+n);return d.toISOString().slice(0,7)};
export function dates(start:string,end:string){const result:string[]=[];for(let d=start;d<end;d=addDays(d,1))result.push(d);return result;}
const israelDate = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jerusalem',year:'numeric',month:'2-digit',day:'2-digit'});
export function todayIsrael(now = new Date()){return israelDate.format(now)}
export function millisecondsUntilIsraelMidnight(now: Date) {
  const start = now.getTime(), day = todayIsrael(now);
  let low = 0, high = 27 * 60 * 60 * 1000;
  // Date comparisons account for Israel's DST changes without assuming a UTC offset.
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (todayIsrael(new Date(start + middle)) === day) low = middle;
    else high = middle;
  }
  return high;
}
export const initialCalendarMonth = () => monthNext(todayIsrael().slice(0,7));
export const calendarMonthLabel = (month:string,lang:'en'|'he') => new Date(month+'-15T12:00:00Z').toLocaleDateString(lang==='en'?'en-GB':'he-IL',{month:'long',year:'numeric',timeZone:'Asia/Jerusalem'});

export function calendarDates(month:string) {
  return dates(addDays(month+'-01',-dayOf(month+'-01')),addDays(monthNext(month)+'-01',(7-dayOf(monthNext(month)+'-01'))%7));
}

type Period = {start:string;end:string;kind:string};
// The real calendar supplies verified blocks (including splits/specials). The
// public shell supplies only ordinary date-based weekends, never a cached plan.
export function calendarCells<T extends Period>(dateCells:string[],periods:readonly T[]) {
  return dateCells.flatMap(date=>{
    const period=periods.find(b=>b.start<=date&&date<b.end);
    const combined=period?.kind==='weekend'&&period.end===addDays(period.start,2);
    return combined&&date!==period.start?[]:[{date,period,combined}];
  });
}

export function publicCalendarCells(month:string) {
  const dateCells=calendarDates(month);
  const weekends=dateCells.filter(d=>dayOf(d)===5)
    .map(start=>({start,end:addDays(start,2),kind:'weekend'}));
  return calendarCells(dateCells,weekends);
}
