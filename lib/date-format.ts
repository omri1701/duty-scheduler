// Keep date-only display at noon UTC, using the caller's browser time zone.
export function shortDate(day:string,lang:'en'|'he'){
 return new Date(day+'T12:00:00Z').toLocaleDateString(lang==='en'?'en-GB':'he-IL',{day:'numeric',month:'short'});
}

// Sort date-only keys so reverse drags display the same chronological range.
export function dateRange(days:string[],lang:'en'|'he'){
 const ordered=[...days].sort(),first=ordered[0],last=ordered.at(-1);
 if(!first||!last)return '';
 const locale=lang==='en'?'en-GB':'he-IL';
 const format=(day:string)=>new Date(day+'T12:00:00Z').toLocaleDateString(locale,{day:'numeric',month:'long',...(first.slice(0,4)!==last.slice(0,4)?{year:'numeric' as const}:{})});
 if(first===last)return format(first);
 if(first.slice(0,7)===last.slice(0,7))return `${Number(first.slice(-2))}–${format(last)}`;
 return `${format(first)}–${format(last)}`;
}
