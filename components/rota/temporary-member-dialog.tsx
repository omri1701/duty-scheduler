'use client';
import {useState} from 'react';
import {Button} from '@/components/ui/button';
import {Sheet} from '@/components/ui/sheet';
import type {TeamWorkspace} from '@/hooks/use-team-workspace';
import type {Member} from '@/lib/supabase/snapshot';
import {userMessage} from '@/lib/messages';

/** Add or rename a temporary member (no sign-in account; admins manage their constraints). */
export function TemporaryMemberDialog({member,remote,lang,onClose}:{member:Member|null;remote:TeamWorkspace;lang:'en'|'he';onClose:()=>void}) {
 const t=(en:string,he:string)=>lang==='he'?he:en;
 const [name,setName]=useState(member?.name??''),[error,setError]=useState(''),[submitting,setSubmitting]=useState(false);
 const busy=submitting||remote.saving;
 async function submit(){
  if(busy||remote.readOnly||!name.trim())return;
  setSubmitting(true);setError('');
  try{if(member)await remote.renameTemporaryMember(member.id,name);else await remote.addTemporaryMember(name);onClose()}
  catch(e){setError(userMessage((e as Error).message,t))}finally{setSubmitting(false)}
 }
 return <Sheet open onOpenChange={open=>{if(!open&&!busy)onClose()}} lang={lang} kind="alert" closeDisabled={busy} busy={busy}
  title={member?t('Edit name','עריכת שם'):t('Add temporary member','הוספת חבר זמני')} description={member?undefined:t('No sign-in; you enter their constraints.','בלי התחברות; את/ה מזין/ה את האילוצים שלהם.')}
  footer={<div className="sheet-actions"><Button variant="secondary" disabled={busy} onClick={onClose}>{t('Cancel','ביטול')}</Button><Button disabled={busy||remote.readOnly||!name.trim()} onClick={submit}>{member?t('Save','שמירה'):t('Add','הוספה')}</Button></div>}>
  <form onSubmit={e=>{e.preventDefault();void submit()}}>
   <label className="field-label">{t('Name','שם')}<input required maxLength={80} value={name} disabled={busy||remote.readOnly} onChange={e=>setName(e.target.value)} autoFocus/></label>
   {error&&<p className="note-line" data-tone="danger" role="alert">{error}</p>}
  </form>
 </Sheet>;
}
