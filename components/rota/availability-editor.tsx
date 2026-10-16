'use client';
import {useLayoutEffect,useRef,useState} from 'react';
import {Trash2} from 'lucide-react';
import {EditorDialog} from '@/components/rota/editor-dialog';
import {useMobileLayout} from '@/hooks/use-mobile-layout';
import {tactileTick,tactileVisual} from '@/lib/tactile';
import {dateRange,shortDate} from '@/lib/date-format';
import {Button} from '@/components/ui/button';
import {useHoldDrag} from '@/hooks/use-hold-drag';
import {dates,addDays,type State} from '@/lib/rota/engine';
type EditKind='no'|'prefer'|'clear';
export function AvailabilityEditor({state,month,person,cells,lang,disabled,onSave}:{state:State;month:string;person:string;cells:string[];lang:'en'|'he';disabled:boolean;onSave:(days:string[],kind:EditKind,note:string)=>boolean|void|Promise<boolean|void>}){
 const mobile=useMobileLayout();
 const t=(a:string,b:string)=>lang==='en'?a:b;
 const [selection,setSelection]=useState<string[]>([]),[kind,setKind]=useState<'no'|'prefer'>('no'),[note,setNote]=useState(''),[open,setOpen]=useState(false),[saving,setSaving]=useState(false);
 const [confirmation,setConfirmation]=useState<{value:EditKind;signature:string;changed?:boolean}|null>(null);
 const anchor=useRef(''),lastSelected=useRef(''),selectionRef=useRef(selection),saveLock=useRef(false);
 useLayoutEffect(()=>{selectionRef.current=selection},[selection]);
 const [context,setContext]=useState({person,month,disabled});
 const liveContext=useRef(context);
 useLayoutEffect(()=>{liveContext.current=context},[context]);
 if(context.person!==person||context.month!==month||context.disabled!==disabled){
  setContext({person,month,disabled});setSelection([]);setNote('');setOpen(false);setConfirmation(null);
 }
 function edit(days:string[]){if(!days.length)return;setNote(days.length===1?state.constraintNotes?.[person]?.[days[0]]??'':'');setKind(state.constraints[person]?.[days[0]]??'no');setConfirmation(null);setOpen(true)}
 function close(){if(saveLock.current)return;setOpen(false);setConfirmation(null);setSelection([]);selectionRef.current=[];anchor.current='';setNote('')}
 function select(days:string[]){const unique=[...new Set(days)];selectionRef.current=unique;setSelection(unique);if(unique.length)lastSelected.current=unique[0]}
 function range(a:string,b:string){return dates(a<b?a:b,addDays(a<b?b:a,1)).filter(d=>d.startsWith(month))}
 const {container,bindContainer,ignoreClick}=useHoldDrag({enabled:!disabled&&!open,holdMs:280,onStart:key=>{anchor.current=key;select([key])},onMove:key=>{if(anchor.current)select(range(anchor.current,key))},onEnd:key=>{const a=anchor.current;anchor.current='';if(!a||!key){close();return}const days=range(a,key);select(days);edit(days)},onCancel:close});
 function toggle(d:string){if(ignoreClick()||disabled)return;select([d]);if(mobile){tactileTick();tactileVisual(container.current?.querySelector(`[data-gesture-key="${d}"]`)??null)}edit([d])}
 const hasPersistedSelection=selection.some(d=>!!state.constraints[person]?.[d]||!!state.constraintNotes?.[person]?.[d]);
 const hasNotes=selection.some(d=>!!state.constraintNotes?.[person]?.[d]);
 function conflicts(value:EditKind){return selection.some(d=>{
  const previous=state.constraints[person]?.[d],description=state.constraintNotes?.[person]?.[d]??'';
  return value==='clear'?!!description:selection.length>1&&((!!previous&&previous!==value)||(!!description&&description!==note));
 })}
 const signature=JSON.stringify([person,selection.map(d=>[d,state.constraints[person]?.[d],state.constraintNotes?.[person]?.[d]])]);
 async function save(value:EditKind,confirmed=false){
  if(saveLock.current||disabled||!selectionRef.current.length)return;
  if(conflicts(value)&&!confirmed){setConfirmation({value,signature});return}
  if(confirmed&&confirmation?.signature!==signature){setConfirmation({value,signature,changed:true});return}
  saveLock.current=true;setSaving(true);
  const days=[...selectionRef.current],editingPerson=person,editingMonth=month;
  try{if(await onSave(days,value,note)!==false&&liveContext.current.person===editingPerson&&liveContext.current.month===editingMonth&&!liveContext.current.disabled){saveLock.current=false;close()}}
  finally{saveLock.current=false;setSaving(false);setConfirmation(null)}
 }
 const title=(d:string)=>shortDate(d,lang);
 const restoreFocus=(e:Event)=>{e.preventDefault();container.current?.querySelector<HTMLButtonElement>(`[data-gesture-key="${lastSelected.current}"]`)?.focus()};
 const rangeTitle=dateRange(selection,lang),count=new Set(selection).size;
 const selectionCount=lang==='en'?`${count} ${count===1?'day':'days'} selected`:count===1?'נבחר יום אחד':`נבחרו ${count} ימים`;
 function warning(value:EditKind){
  if(value==='clear')return t('Removing constraints will also permanently delete existing descriptions from the selected dates.','הסרת האילוצים תמחק גם את התיאורים הקיימים בתאריכים שנבחרו.');
  const change=t('This will replace existing availability on all selected dates.','פעולה זו תחליף את הזמינות הקיימת בכל התאריכים שנבחרו.');
  return change+(hasNotes?(note.trim()?t(' Existing descriptions will be replaced with the new description.',' התיאורים הקיימים יוחלפו בתיאור החדש.'):t(' The description is blank: existing descriptions will be cleared.',' התיאור ריק: התיאורים הקיימים יימחקו.')):'');
 }
 return <div className="constraint-editor"><div className="availability-tools"><p className="gesture-hint" role="status" aria-atomic="true">{count?selectionCount:t('Tap a day · Hold & drag for a range','לחצו על יום · לחיצה ארוכה וגרירה לטווח')}</p></div>
 <EditorDialog open={open} onClose={close} saving={saving} lang={lang} title={<bdi>{rangeTitle}</bdi>} description={<span className="constraint-range-help">{selection.length>1?t('Applies to all selected dates','חל על כל התאריכים שנבחרו'):t('Choose availability for this date.','בחרו זמינות לתאריך זה.')}</span>} className="availability-dialog" onCloseAutoFocus={restoreFocus}>
  {conflicts(kind)&&<p className="constraint-notes-help" role="status">{warning(kind)} {t('You will be asked to confirm before saving.','לפני השמירה יידרש אישור.')}</p>}
  <div className="constraint-choices">
   <button disabled={saving} aria-pressed={kind==='no'} className={kind==='no'?'chosen no':''} onClick={()=>setKind('no')}>{t('Unavailable','לא זמין')}</button>
   <button disabled={saving} aria-pressed={kind==='prefer'} className={kind==='prefer'?'chosen prefer':''} onClick={()=>setKind('prefer')}>{t('Prefer duty','מעדיף תורנות')}</button>
  </div>
  <label className="field-label">{t('Description (optional)','תיאור (לא חובה)')}<textarea disabled={saving} value={note} maxLength={300} rows={2} placeholder={t('Vacation, appointment…','חופשה, תור…')} onChange={e=>setNote(e.target.value)}/></label>
  {hasPersistedSelection&&<Button disabled={saving} variant="outline" className="remove-constraint" onClick={()=>save('clear')}><Trash2 size={16}/>{t('Remove constraint','הסרת אילוץ')}</Button>}
  <div className="editor-actions">
   <Button disabled={saving} onClick={()=>save(kind)}>{t('Save','שמירה')}</Button>
  </div>
  <EditorDialog open={!!confirmation} onClose={()=>{if(!saveLock.current)setConfirmation(null)}} saving={saving} lang={lang} role="alertdialog" title={t('Replace existing availability?','להחליף את הזמינות הקיימת?')} description={confirmation?warning(confirmation.value):''}>
   {confirmation?.changed&&<p role="status" className="constraint-notes-help">{t('Availability changed. Review the warning and confirm again.','הזמינות השתנתה. בדקו את האזהרה ואשרו שוב.')}</p>}
   <div className="editor-actions">
    <Button variant="outline" disabled={saving} onClick={()=>setConfirmation(null)}>{t('Cancel','ביטול')}</Button>
    <Button disabled={saving} onClick={()=>{if(confirmation)save(confirmation.value,true)}}>{confirmation?.value==='clear'?t('Remove constraints and notes','הסרת אילוצים והערות'):t('Replace and save','החלפה ושמירה')}</Button>
   </div>
  </EditorDialog>
 </EditorDialog>
 <div className="mobile-availability-legend" aria-hidden="true"><span><i className="availability-marker no"/>{t('Unavailable','לא זמין')}</span><span><i className="availability-marker prefer"/>{t('Preferred','מועדף')}</span></div>
 <div className="mobile-availability-weekdays" aria-hidden="true">{(lang==='en'?['Sun','Mon','Tue','Wed','Thu','Fri','Sat']:['א׳','ב׳','ג׳','ד׳','ה׳','ו׳','ש׳']).map(d=><span key={d}>{d}</span>)}</div>
 <div ref={bindContainer} className="availability-grid gesture-grid">{cells.map(d=>{const status=state.constraints[person]?.[d],outside=!d.startsWith(month),selected=selection.includes(d),n=state.constraintNotes?.[person]?.[d],label=status==='no'?t('Unavailable','לא זמין'):status==='prefer'?t('Preferred','מועדף'):t('Available','זמין');return <button key={d} type="button" data-gesture-key={!outside?d:undefined} disabled={disabled||outside} onClick={()=>toggle(d)} aria-pressed={selected} aria-label={`${title(d)} · ${label}${n?' · '+n:''}`} className={['availability-day',outside?'outside':'',status??'',selected?'date-selected':''].join(' ')}><span className="availability-weekday">{new Date(d+'T12:00:00Z').toLocaleDateString(lang==='en'?'en-GB':'he-IL',{weekday:'short'})}</span><strong>{Number(d.slice(-2))}</strong>{n?.trim()&&<span className="mobile-note-dot" aria-hidden="true"/>}<span className="availability-description">{n||label}</span></button>})}</div>
 </div>
}
