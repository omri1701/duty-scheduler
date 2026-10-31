'use client';
import {useState} from 'react';
import {Popover,PopoverContent,PopoverTrigger} from '@/components/ui/popover';
import {shortDate} from '@/lib/date-format';
import {calendarMonthLabel} from '@/lib/rota/calendar-dates';
import {loneHalf} from '@/lib/compensation';
import {relationships,signedPoints,type Balance,type BalanceLine} from '@/lib/supabase/balance';

/** Projected from published schedules only. Hover, tap or focus shows the open relationships. */
export function NetBalance({memberId,memberName,balance,name,lang}:{memberId:string;memberName:string;balance:Balance;name:(id:string)=>string;lang:'en'|'he'}){
 const [open,setOpen]=useState(false);
 const t=(a:string,b:string)=>lang==='en'?a:b;
 const units=balance.net[memberId];
 if(units===undefined)return <div className="team-points net-points" aria-hidden="true"/>;
 const rows=relationships(balance,memberId);
 const source=(l:BalanceLine,counterpart:string)=>{
  const when=l.date?' · '+shortDate(l.date,lang):l.month?' · '+calendarMonthLabel(l.month,lang):'';
  switch(l.kind){
   case 'temporary':return (l.units>0?t(`Covered ${counterpart}'s duty`,`כיסוי תורנות של ${counterpart}`):t(`${counterpart} covered a duty`,`תורנות כוסתה על ידי ${counterpart}`))+when+' · '+t('temporary','זמני');
   case 'uneven':return t('Uneven monthly split','חלוקה חודשית לא שווה')+when+' · '+t('temporary','זמני');
   case 'repayment':return t('Repayment scheduled','החזר מתוכנן')+when;
   case 'change':return t('Published change','שינוי שפורסם')+when;
   case 'manual':return t('Manual adjustment','התאמה ידנית');
   case 'correction':return t('Correction','תיקון');
   case 'routed':return t('Carried through the team','הועבר דרך הצוות');
   default:return t('Other','אחר');
  }
 };
 return <div className="team-points net-points" onPointerDown={e=>e.stopPropagation()} onTouchStart={e=>e.stopPropagation()}>
  <Popover open={open} onOpenChange={setOpen}>
   <PopoverTrigger asChild><button type="button" className={units<0?'owes':units>0?'owed':undefined}
    aria-label={`${t('Net balance','מאזן נטו')} ${memberName} ${signedPoints(units)}`}
    onClick={e=>{e.preventDefault();setOpen(true)}} onFocus={()=>setOpen(true)} onBlur={()=>setOpen(false)}
    onPointerEnter={e=>{if(e.pointerType==='mouse')setOpen(true)}} onPointerLeave={e=>{if(e.pointerType==='mouse')setOpen(false)}}>
    <strong dir="ltr">{signedPoints(units)}</strong><span>{t('net','נטו')}</span>
   </button></PopoverTrigger>
   <PopoverContent className="net-breakdown" dir={lang==='he'?'rtl':'ltr'} onOpenAutoFocus={e=>e.preventDefault()} onCloseAutoFocus={e=>e.preventDefault()}>
    <strong>{t('Projected from published schedules','תחזית לפי הסידורים שפורסמו')}</strong>
    {rows.length?rows.map(r=>{const counterpart=name(r.counterpartId);return <div key={r.counterpartId}>
     <p><span>{counterpart}</span><bdi dir="ltr">{signedPoints(r.units)}</bdi></p>
     {r.lines.map((l,i)=><small key={i}>{source(l,counterpart)} <bdi dir="ltr">{signedPoints(l.units)}</bdi></small>)}
     {!!loneHalf(r.units)&&<small>{t('0.5 waiting for the second half','0.5 ממתין לחצי השני')}</small>}
    </div>}):<small>{t('No open balances','אין יתרות פתוחות')}</small>}
    <small>{t('Positive: owed relief · Negative: owes work','חיובי: זכאות להקלה · שלילי: עבודה להחזרה')}</small>
   </PopoverContent>
  </Popover>
 </div>;
}
