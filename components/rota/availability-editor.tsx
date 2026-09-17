'use client';
import {useEffect,useRef,useState} from 'react';
import {Trash2,X} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Popover,PopoverAnchor,PopoverContent} from '@/components/ui/popover';
import {useHoldDrag} from '@/hooks/use-hold-drag';
import {dates,addDays,type State} from '@/lib/rota/engine';
export function AvailabilityEditor({state,month,person,cells,lang,disabled,onSave}:{state:State;month:string;person:string;cells:string[];lang:'en'|'he';disabled:boolean;onSave:(days:string[],kind:'no'|'prefer'|'clear',note:string)=>void}){
 const t=(a:string,b:string)=>lang==='en'?a:b;
 const [selection,setSelection]=useState<string[]>([]),[kind,setKind]=useState<'no'|'prefer'>('no'),[note,setNote]=useState(''),[open,setOpen]=useState(false);
 const anchor=useRef(''),lastSelected=useRef(''),selectionRef=useRef(selection);selectionRef.current=selection;
 const rect=useRef<DOMRect|null>(null),virtual=useRef({getBoundingClientRect:()=>rect.current??new DOMRect()});
 useEffect(()=>{setSelection([]);setNote('');setOpen(false)},[person,month,disabled]);
 function position(d:string){const el=gesture.container.current?.querySelector(`[data-gesture-key="${d}"]`);if(el)rect.current=el.getBoundingClientRect()}
 function edit(days:string[]){if(!days.length)return;position(days.at(-1)!);setNote(days.length===1?state.constraintNotes?.[person]?.[days[0]]??'':'');setKind(state.constraints[person]?.[days[0]]??'no');setOpen(true)}
 function close(){setOpen(false);setSelection([]);selectionRef.current=[];anchor.current='';setNote('')}
 function select(days:string[]){selectionRef.current=days;setSelection(days);if(days.length)lastSelected.current=days[0]}
 function range(a:string,b:string){return dates(a<b?a:b,addDays(a<b?b:a,1)).filter(d=>d.startsWith(month))}
 const gesture=useHoldDrag({enabled:!disabled&&!open,holdMs:280,onStart:key=>{anchor.current=key;select([key]);if(typeof navigator.vibrate==='function')navigator.vibrate(10)},onMove:key=>{if(anchor.current)select(range(anchor.current,key))},onEnd:key=>{const a=anchor.current;anchor.current='';if(!a||!key){close();return}const days=range(a,key);select(days);edit(days)},onCancel:close});
 function toggle(d:string){if(gesture.ignoreClick()||disabled)return;select([d]);edit([d])}
 function save(value:'no'|'prefer'|'clear'){onSave(selectionRef.current,value,note);close()}
 const title=(d:string)=>new Date(d+'T12:00:00Z').toLocaleDateString(lang==='en'?'en-GB':'he-IL',{day:'numeric',month:'short'});
 return <div className="constraint-editor"><div className="availability-tools"><p className="gesture-hint">{t('Tap a day · Hold & drag for a range','לחצו על יום · לחיצה ארוכה וגרירה לטווח')}</p><span className="selection-count" role="status">{selection.length>1?`${selection.length} ${t('days selected','ימים נבחרו')}`:''}</span></div>
 <Popover open={open} onOpenChange={v=>{if(v)setOpen(true);else close()}}><PopoverAnchor virtualRef={virtual}/><PopoverContent className="constraint-popover" align="center" side="bottom" collisionPadding={12} dir={lang==='he'?'rtl':'ltr'} onOpenAutoFocus={e=>e.preventDefault()} onCloseAutoFocus={e=>{e.preventDefault();gesture.container.current?.querySelector<HTMLButtonElement>(`[data-gesture-key="${lastSelected.current}"]`)?.focus()}}><div className="constraint-popover-title"><strong>{selection.length===1?title(selection[0]):`${selection.length} ${t('days','ימים')}`}</strong><button type="button" onClick={close} aria-label={t('Close and deselect days','סגירה וביטול בחירת הימים')}><X size={18}/></button></div><div className="constraint-choices"><button aria-pressed={kind==='no'} className={kind==='no'?'chosen no':''} onClick={()=>setKind('no')}>{t('Unavailable','לא זמין')}</button><button aria-pressed={kind==='prefer'} className={kind==='prefer'?'chosen prefer':''} onClick={()=>setKind('prefer')}>{t('Prefer duty','מעדיף תורנות')}</button></div><label className="field-label">{t('Description (optional)','תיאור (לא חובה)')}<textarea value={note} maxLength={300} rows={2} placeholder={t('Vacation, appointment…','חופשה, תור…')} onChange={e=>setNote(e.target.value)}/></label><div className="constraint-popover-actions"><Button variant="outline" className="remove-constraint" onClick={()=>save('clear')}><Trash2 size={16}/>{t('Remove constraint','הסרת אילוץ')}</Button><Button onClick={()=>save(kind)}>{t('Save','שמירה')}</Button></div></PopoverContent></Popover>
 <div ref={gesture.container} className="availability-grid gesture-grid">{cells.map(d=>{const status=state.constraints[person]?.[d],outside=!d.startsWith(month),selected=selection.includes(d),n=state.constraintNotes?.[person]?.[d],label=status==='no'?t('Unavailable','לא זמין'):status==='prefer'?t('Preferred','מועדף'):t('Available','זמין');return <button key={d} type="button" data-gesture-key={!outside?d:undefined} disabled={disabled||outside} onClick={()=>toggle(d)} aria-pressed={selected} aria-label={`${title(d)} · ${label}${n?' · '+n:''}`} className={['availability-day',outside?'outside':'',status??'',selected?'date-selected':''].join(' ')}><span>{new Date(d+'T12:00:00Z').toLocaleDateString(lang==='en'?'en-GB':'he-IL',{weekday:'short'})}</span><strong>{Number(d.slice(-2))}</strong><span className="availability-description">{n||label}</span></button>})}</div>
 </div>
}
