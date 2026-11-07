'use client';
import {useEffect,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Sheet} from '@/components/ui/sheet';
import {Chip} from '@/components/ui/chip';
import type {TeamWorkspace} from '@/hooks/use-team-workspace';
import {fromSnapshot} from '@/lib/supabase/snapshot';
import {addDays,blocks,dates,dayOf,monthNext} from '@/lib/rota/engine';
import {memberStyle} from '@/lib/theme/palette';
import {userMessage} from '@/lib/messages';

/** Published versions of a month (⋯ → Versions): pick one to preview, restore it as a draft or delete it. */
export function PublicationHistory({remote,month,open,onOpenChange,lang}:{remote:TeamWorkspace;month:string;open:boolean;onOpenChange:(open:boolean)=>void;lang:'en'|'he'}){
 const [selected,setSelected]=useState<string|null>(null),[action,setAction]=useState<{id:string;kind:'restore'|'delete'}|null>(null),[error,setError]=useState('');
 const t=(en:string,he:string)=>lang==='en'?en:he,raw=remote.snapshot!;
 const versions=raw.publications.filter(p=>p.month===month).sort((a,b)=>b.version-a.version),current=raw.months.find(m=>m.month===month)?.current_publication_id;
 const viewed=versions.find(p=>p.id===selected)??versions[0],preview=viewed?fromSnapshot(raw,remote.user!.id,viewed.id):null,bs=preview?blocks(month,preview.specials,preview.splitWeekends):[];
 const cells=dates(addDays(month+'-01',-dayOf(month+'-01')),addDays(monthNext(month)+'-01',(7-dayOf(monthNext(month)+'-01'))%7));
 const target=versions.find(p=>p.id===action?.id);
 // Versions a re-plan reversed can't come back (decision 2026-11-01): their buttons are disabled with a note before the click.
 const [replanned,setReplanned]=useState<string[]>([]),revision=raw.revision,load=remote.replannedVersions;
 useEffect(()=>{
  if(!open)return;
  let alive=true;
  load(month).then(ids=>{if(alive)setReplanned(ids)},()=>{if(alive)setReplanned([])});
  return()=>{alive=false};
  // eslint-disable-next-line react-hooks/exhaustive-deps -- load is recreated each render; open, month and revision are the trigger.
 },[open,month,revision]);
 const replacement=versions.find(p=>p.id!==viewed?.id),restoreBlocked=!!viewed&&replanned.includes(viewed.id),
  deleteBlocked=!!viewed&&viewed.id===current&&!!replacement&&replanned.includes(replacement.id);
 async function confirm(){if(!action)return;try{if(action.kind==='restore')await remote.restore(action.id);else await remote.deleteVersion(action.id);setAction(null);setError('');if(action.kind==='restore')onOpenChange(false)}catch(e){setError(userMessage((e as Error).message,t))}}
 const when=(iso:string)=>new Date(iso).toLocaleString(lang==='en'?'en-GB':'he-IL',{timeZone:'Asia/Jerusalem',dateStyle:'medium',timeStyle:'short'});
 return <Sheet open={open} onOpenChange={onOpenChange} lang={lang} desktop="center" size="lg" className="history-sheet" title={t('Versions','גרסאות')} description={t('Restoring makes a draft; publish it when ready.','שחזור יוצר טיוטה; מפרסמים כשמוכנים.')}
  footer={versions.length>0&&<div className="sheet-actions">
   <Button variant="secondary" disabled={remote.readOnly||remote.saving||deleteBlocked} onClick={()=>{setAction({id:viewed.id,kind:'delete'});setError('')}}>{t('Delete version','מחיקת גרסה')}</Button>
   <Button disabled={remote.readOnly||remote.saving||restoreBlocked} onClick={()=>{setAction({id:viewed.id,kind:'restore'});setError('')}}>{t('Restore as draft','שחזור כטיוטה')}</Button>
  </div>}>
  {!versions.length?<p className="muted">{t('No published versions yet.','עדיין אין גרסאות שפורסמו.')}</p>:<>
   <div className="history-versions">{versions.map(v=><button key={v.id} type="button" className={viewed?.id===v.id?'selected':''} aria-pressed={viewed?.id===v.id} onClick={()=>{setSelected(v.id);setAction(null);setError('')}}>
    <strong>v{v.version}{v.id===current&&<Chip tone="ok" size="sm">{t('Live','מוצגת לצוות')}</Chip>}</strong><span>{when(v.published_at)}</span><small>{raw.members.find(m=>m.id===v.published_by)?.name}</small>
   </button>)}</div>
   <div className="history-calendar">
    <div className="calendar-weekdays">{(lang==='en'?['Sun','Mon','Tue','Wed','Thu','Fri','Sat']:['א׳','ב׳','ג׳','ד׳','ה׳','ו׳','ש׳']).map(d=><span key={d}>{d}</span>)}</div>
    <div className="calendar-grid history-grid">{cells.map(day=>{const b=bs.find(b=>b.start<=day&&b.end>day),combined=!!b&&b.end===addDays(b.start,2);if(combined&&day!==b.start)return null;const a=b?preview!.assignments[b.id]:undefined,p=preview!.team.find(p=>p.id===a?.primary);
     return <div key={day} className={'history-day '+(!day.startsWith(month)?'outside ':'')+(b?.weekendId?'weekend':'')} style={combined?{gridColumn:'span 2'}:undefined}>
      <strong className={combined?'history-dates':undefined}><span>{Number(day.slice(-2))}</span>{combined&&<span>{Number(addDays(b!.end,-1).slice(-2))}</span>}</strong>
      {p&&<span className="member-tint history-pill" style={memberStyle(p.color)}>{p.name.split(' ')[0]}</span>}{b?.title&&<small>{b.title}</small>}{a?.secondary&&<small>+ {preview!.team.find(p=>p.id===a.secondary)?.name.split(' ')[0]}</small>}
     </div>})}</div>
   </div>
   {(restoreBlocked||deleteBlocked)&&<p className="note-line" role="note">{restoreBlocked?t('This month was re-planned after this version, so it can’t be restored. Reopen the month and change its plan instead.','החודש תוכנן מחדש אחרי הגרסה הזו, ולכן אי אפשר לשחזר אותה. יש לפתוח מחדש את החודש ולשנות את התוכנית שלו.'):t(`Deleting this version would bring back v${replacement!.version}, from before the month was re-planned. Reopen the month and change its plan instead.`,`מחיקת הגרסה הזו תחזיר את גרסה ${replacement!.version}, מלפני שהחודש תוכנן מחדש. יש לפתוח מחדש את החודש ולשנות את התוכנית שלו.`)}</p>}
   {target&&action&&<div className="note-line" data-tone={action.kind==='delete'?'danger':undefined} style={{display:'block'}} role="alertdialog" aria-label={t('Confirm','אישור')}>
    <p>{action.kind==='restore'?t(`Restore v${target.version}? This replaces the draft for this month.`,`לשחזר את גרסה ${target.version}? הטיוטה לחודש זה תוחלף.`):target.id===current?t(`Delete live v${target.version}? The newest remaining version becomes live; with none left the month is unpublished.`,`למחוק את גרסה ${target.version} שמוצגת לצוות? הגרסה האחרונה שנותרה תוצג במקומה; בלי גרסאות הפרסום יבוטל.`):t(`Delete v${target.version}? This cannot be undone.`,`למחוק את גרסה ${target.version}? לא ניתן לבטל פעולה זו.`)}</p>
    <div className="sheet-actions" style={{marginTop:8}}><Button size="sm" variant="ghost" disabled={remote.readOnly||remote.saving} onClick={()=>setAction(null)}>{t('Cancel','ביטול')}</Button><Button size="sm" variant={action.kind==='delete'?'destructive':'default'} disabled={remote.readOnly||remote.saving} onClick={confirm}>{t('Confirm','אישור')}</Button></div>
   </div>}
  </>}
  {error&&<p className="note-line" data-tone="danger" role="alert">{error}</p>}
 </Sheet>;
}
