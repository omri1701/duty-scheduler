// Keep date-only display at noon UTC, using the caller's browser time zone.
export function shortDate(day:string,lang:'en'|'he'){
 return new Date(day+'T12:00:00Z').toLocaleDateString(lang==='en'?'en-GB':'he-IL',{day:'numeric',month:'short'});
}
