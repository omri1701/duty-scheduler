'use client';
import {useLayoutEffect,useRef,useState} from 'react';
import {Trash2,X} from 'lucide-react';
import {Dialog,DialogContent,DialogTitle} from '@/components/ui/dialog';
import {useMobileLayout} from '@/hooks/use-mobile-layout';
import {tactileTick,tactileVisual} from '@/lib/tactile';
import {dateRange,shortDate} from '@/lib/date-format';
import {Button} from '@/components/ui/button';
import {Popover,PopoverAnchor,PopoverContent} from '@/components/ui/popover';
import {useHoldDrag} from '@/hooks/use-hold-drag';
import {dates,addDays,type State} from '@/lib/rota/engine';
export function AvailabilityEditor({state,month,person,cells,lang,disabled,onSave}:{state:State;month:string;person:string;cells:string[];lang:'en'|'he';disabled:boolean;onSave:(days:string[],kind:'no'|'prefer'|'clear',note:string)=>boolean|void|Promise<boolean|void>}){
 const mobile=useMobileLayout();
 const t=(a:string,b:string)=>lang==='en'?a:b;
 const [selection,setSelection]=useState<string[]>([]),[kind,setKind]=useState<'no'|'prefer'>('no'),[note,setNote]=useState(''),[open,setOpen]=useState(false),[saving,setSaving]=useState(false);
 const anchor=useRef(''),lastSelected=useRef(''),selectionRef=useRef(selection);
 useLayoutEffect(()=>{selectionRef.current=selection},[selection]);
 const rect=useRef<DOMRect|null>(null),virtual=useRef({getBoundingClientRect:()=>rect.current??new DOMRect()});
 const [context,setContext]=useState({person,month,disabled});
 // Reset only the editable fields when the availability context changes.
 if(context.person!==person||context.month!==month||context.disabled!==disabled){
  setContext({person,month,disabled});setSelection([]);setNote('');setOpen(false);
 }
 function position(d:string){const el=container.current?.querySelector(`[data-gesture-key="${d}"]`);if(el)rect.current=el.getBoundingClientRect()}
 function edit(days:string[]){if(!days.length)return;position(days.at(-1)!);setNote(days.length===1?state.constraintNotes?.[person]?.[days[0]]??'':'');setKind(state.constraints[person]?.[days[0]]??'no');setOpen(true)}
 function close(){setOpen(false);setSelection([]);selectionRef.current=[];anchor.current='';setNote('')}
 function select(days:string[]){selectionRef.current=days;setSelection(days);if(days.length)lastSelected.current=days[0]}
 function range(a:string,b:string){return dates(a<b?a:b,addDays(a<b?b:a,1)).filter(d=>d.startsWith(month))}
 const {container,bindContainer,ignoreClick}=useHoldDrag({enabled:!disabled&&!open,holdMs:280,onStart:key=>{anchor.current=key;select([key])},onMove:key=>{if(anchor.current)select(range(anchor.current,key))},onEnd:key=>{const a=anchor.current;anchor.current='';if(!a||!key){close();return}const days=range(a,key);select(days);edit(days)},onCancel:close});
 function toggle(d:string){if(ignoreClick()||disabled)return;select([d]);if(mobile){tactileTick();tactileVisual(container.current?.querySelector(`[data-gesture-key="${d}"]`)??null)}edit([d])}
 const rangeHasNotes=selection.length>1&&selection.some(d=>state.constraintNotes?.[person]?.[d]?.trim());
 async function save(value:'no'|'prefer'|'clear'){if(saving||(value!=='clear'&&rangeHasNotes))return;setSaving(true);try{if(await onSave([...selectionRef.current],value,note)!==false)close()}finally{setSaving(false)}}
 const title=(d:string)=>shortDate(d,lang);
 const restoreFocus=(e:Event)=>{e.preventDefault();container.current?.querySelector<HTMLButtonElement>(`[data-gesture-key="${lastSelected.current}"]`)?.focus()};
 const rangeTitle=dateRange(selection,lang);
 const heading=<strong><bdi>{rangeTitle}</bdi></strong>;
 const editor=<>
  <div className="constraint-popover-title">
   {mobile?<DialogTitle asChild>{heading}</DialogTitle>:heading}
   <button type="button" disabled={saving} onClick={close} aria-label={t('Close and deselect days','סגירה וביטול בחירת הימים')}><X size={18}/></button>
  </div>
  {selection.length>1&&<p className="constraint-range-help">{t('Applies to all selected dates','חל על כל התאריכים שנבחרו')}</p>}
  {rangeHasNotes&&<p className="constraint-notes-help" role="status">{t('This range contains notes. Edit dates individually to keep them.','בטווח יש הערות. ערכו כל תאריך בנפרד כדי לשמור עליהן.')}</p>}
  <div className="constraint-choices">
   <button disabled={saving||rangeHasNotes} aria-pressed={kind==='no'} className={kind==='no'?'chosen no':''} onClick={()=>setKind('no')}>{t('Unavailable','לא זמין')}</button>
   <button disabled={saving||rangeHasNotes} aria-pressed={kind==='prefer'} className={kind==='prefer'?'chosen prefer':''} onClick={()=>setKind('prefer')}>{t('Prefer duty','מעדיף תורנות')}</button>
  </div>
  <label className="field-label">{t('Description (optional)','תיאור (לא חובה)')}<textarea disabled={saving||rangeHasNotes} value={note} maxLength={300} rows={2} placeholder={t('Vacation, appointment…','חופשה, תור…')} onChange={e=>setNote(e.target.value)}/></label>
  <div className="constraint-popover-actions">
   <Button disabled={saving} variant="outline" className="remove-constraint" onClick={()=>save('clear')}><Trash2 size={16}/>{t('Remove constraint','הסרת אילוץ')}</Button>
   <Button disabled={saving||rangeHasNotes} onClick={()=>save(kind)}>{t('Save','שמירה')}</Button>
  </div>
 </>;
 return <div className="constraint-editor"><div className="availability-tools"><p className="gesture-hint" role="status">{selection.length&&!open?<bdi>{rangeTitle}</bdi>:t('Tap a day · Hold & drag for a range','לחצו על יום · לחיצה ארוכה וגרירה לטווח')}</p></div>
 {mobile?<Dialog open={open} onOpenChange={v=>{if(!v&&!saving)close()}}><DialogContent className="constraint-popover availability-sheet left-0 top-auto translate-x-0 translate-y-0" showCloseButton={false} aria-describedby={undefined} dir={lang==='he'?'rtl':'ltr'} onPointerDownOutside={e=>e.preventDefault()} onEscapeKeyDown={e=>{if(saving)e.preventDefault()}} onCloseAutoFocus={restoreFocus}>{editor}</DialogContent></Dialog>:<Popover open={open} onOpenChange={v=>{if(v)setOpen(true);else if(!saving)close()}}><PopoverAnchor virtualRef={virtual}/><PopoverContent className="constraint-popover" align="center" side="bottom" collisionPadding={12} dir={lang==='he'?'rtl':'ltr'} onOpenAutoFocus={e=>e.preventDefault()} onCloseAutoFocus={e=>{e.preventDefault();container.current?.querySelector<HTMLButtonElement>(`[data-gesture-key="${lastSelected.current}"]`)?.focus()}}>{editor}</PopoverContent></Popover>}

 <div className="mobile-availability-legend" aria-hidden="true"><span><i className="availability-marker no"/>{t('Unavailable','לא זמין')}</span><span><i className="availability-marker prefer"/>{t('Preferred','מועדף')}</span></div>
 <div className="mobile-availability-weekdays" aria-hidden="true">{(lang==='en'?['Sun','Mon','Tue','Wed','Thu','Fri','Sat']:['א׳','ב׳','ג׳','ד׳','ה׳','ו׳','ש׳']).map(d=><span key={d}>{d}</span>)}</div>
 <div ref={bindContainer} className="availability-grid gesture-grid">{cells.map(d=>{const status=state.constraints[person]?.[d],outside=!d.startsWith(month),selected=selection.includes(d),n=state.constraintNotes?.[person]?.[d],label=status==='no'?t('Unavailable','לא זמין'):status==='prefer'?t('Preferred','מועדף'):t('Available','זמין');return <button key={d} type="button" data-gesture-key={!outside?d:undefined} disabled={disabled||outside} onClick={()=>toggle(d)} aria-pressed={selected} aria-label={`${title(d)} · ${label}${n?' · '+n:''}`} className={['availability-day',outside?'outside':'',status??'',selected?'date-selected':''].join(' ')}><span className="availability-weekday">{new Date(d+'T12:00:00Z').toLocaleDateString(lang==='en'?'en-GB':'he-IL',{weekday:'short'})}</span><strong>{Number(d.slice(-2))}</strong>{n?.trim()&&<span className="mobile-note-dot" aria-hidden="true"/>}<span className="availability-description">{n||label}</span></button>})}</div>
 </div>
}
