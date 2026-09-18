'use client';
import {useEffect,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import type {TeamWorkspace} from '@/hooks/use-team-workspace';
export function ProfileDialog({remote,open,onOpenChange,lang}:{remote:TeamWorkspace;open:boolean;onOpenChange:(open:boolean)=>void;lang:'en'|'he'}){
 const [name,setName]=useState(''),[error,setError]=useState('');
 const t=(en:string,he:string)=>lang==='en'?en:he;
 useEffect(()=>{if(open){setName(remote.me?.name??'');setError('')}},[open]);
 return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent dir={lang==='he'?'rtl':'ltr'}><DialogHeader><DialogTitle>{t('My profile','הפרופיל שלי')}</DialogTitle><DialogDescription>{remote.me?.email}</DialogDescription></DialogHeader><label className="field-label">{t('Display name','שם לתצוגה')}<input maxLength={80} value={name} onChange={e=>setName(e.target.value)}/></label><p className="muted-copy">{t('This name appears on the team calendar.','השם הזה יופיע בלוח התורנויות של הצוות.')}</p>{error&&<p className="warning-note" role="alert">{error}</p>}<Button disabled={remote.saving||!name.trim()} onClick={async()=>{try{await remote.rename(name);onOpenChange(false)}catch(e){setError((e as Error).message)}}}>{t('Save name','שמירת השם')}</Button></DialogContent></Dialog>
}
