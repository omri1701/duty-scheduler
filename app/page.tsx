'use client';
import {useEffect,useRef,useState} from 'react';
import {useTeamWorkspace} from '@/hooks/use-team-workspace';
import {RotaWorkspace} from '@/components/rota/workspace';
import {AccessScreen} from '@/components/auth/access-screen';
export default function Home(){
 const remote=useTeamWorkspace(),[lang,setLanguage]=useState<'en'|'he'>('en');
 // The member's saved language is the default on sign-in and on a new device
 // (decision 2026-11-06), applied once per account unless they already chose here.
 const applied=useRef<string|null>(null),chosen=useRef(false),saved=remote.me?.language,userId=remote.user?.id;
 useEffect(()=>{
  if(!userId||applied.current===userId||remote.me===undefined)return;
  applied.current=userId;
  if(saved&&!chosen.current)setLanguage(saved);
 },[userId,saved,remote.me]);
 useEffect(()=>{document.documentElement.lang=lang;document.documentElement.dir=lang==='he'?'rtl':'ltr'},[lang]);
 const personal=remote.personal;
 // Changing the language saves it in the background; a failure keeps the choice here.
 const setLang=(next:'en'|'he')=>{chosen.current=true;setLanguage(next);if(next!==remote.me?.language)personal.setLanguage(next).catch(()=>{})};
 return remote.me?.status==='approved'&&remote.me.active&&remote.state
  ?<RotaWorkspace key={remote.user!.id} remote={remote} lang={lang} setLang={setLang}/>
  :<AccessScreen remote={remote} lang={lang} setLang={setLang}/>;
}
