'use client';
import {useState} from 'react';
import {Button} from '@/components/ui/button';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import type {TeamWorkspace} from '@/hooks/use-team-workspace';
import type {Member} from '@/lib/supabase/snapshot';
import {userMessage} from '@/lib/messages';

export function TemporaryMemberDialog({member,remote,lang,onClose}:{member:Member|null;remote:TeamWorkspace;lang:'en'|'he';onClose:()=>void}) {
 const t=(en:string,he:string)=>lang==='he'?he:en;
 const [name,setName]=useState(member?.name??''),[error,setError]=useState(''),[submitting,setSubmitting]=useState(false);
 const busy=submitting||remote.saving;
 return <Dialog open onOpenChange={open=>{if(!open&&!busy)onClose()}}><DialogContent dir={lang==='he'?'rtl':'ltr'} closeDisabled={busy}>
  <DialogHeader><DialogTitle>{member?t('Edit temporary member','עריכת חבר זמני'):t('Add Temporary Member','הוספת חבר זמני')}</DialogTitle>
   <DialogDescription>{t('Temporary engineers have no sign-in account. Admins manage their details and constraints.','למהנדסים זמניים אין חשבון כניסה. מנהלים עורכים את הפרטים והאילוצים שלהם.')}</DialogDescription></DialogHeader>
  <form onSubmit={async event=>{event.preventDefault();if(busy||remote.readOnly)return;setSubmitting(true);setError('');try{if(member)await remote.renameTemporaryMember(member.id,name);else await remote.addTemporaryMember(name);onClose()}catch(e){setError(userMessage((e as Error).message,t))}finally{setSubmitting(false)}}}>
   <label className="field-label">{t('Name','שם')}<input required maxLength={80} value={name} disabled={busy||remote.readOnly} onChange={e=>setName(e.target.value)}/></label>
   {error&&<p className="warning-note" role="alert">{error}</p>}
   <Button type="submit" disabled={busy||remote.readOnly||!name.trim()}>{member?t('Save name','שמירת השם'):t('Add member','הוספת חבר')}</Button>
  </form>
 </DialogContent></Dialog>;
}
