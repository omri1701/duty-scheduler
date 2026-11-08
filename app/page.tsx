'use client';
import {useEffect,useRef,useState} from 'react';
import {useTeamWorkspace} from '@/hooks/use-team-workspace';
import {RotaWorkspace} from '@/components/rota/workspace';
import {AccessScreen} from '@/components/auth/access-screen';
import {useTheme} from '@/hooks/use-theme';
const SIGN_IN_LANGUAGE='duty-sign-in-language';
export default function Home(){
 const remote=useTeamWorkspace(),[lang,setLanguage]=useState<'en'|'he'>('en');
 // Keeps data-theme in step with the device on every screen (lib/theme/theme.ts).
 useTheme();
 // The member's saved language is the default on sign-in and on a new device
 // (decision 2026-11-06), applied once per account unless they already chose here.
 const applied=useRef<string|null>(null),chosen=useRef(false),saved=remote.me?.language,userId=remote.user?.id;
 // A language picked on the sign-in screen survives the Google round trip (owner round 4) and
 // becomes the member's language once they are signed in.
 const signInChoice=useRef<'en'|'he'|null>(null);
 useEffect(()=>{
  let stored:string|null=null;try{stored=localStorage.getItem(SIGN_IN_LANGUAGE)}catch{}
  if(stored!=='en'&&stored!=='he')return;
  signInChoice.current=stored;chosen.current=true;
  // eslint-disable-next-line react-hooks/set-state-in-effect -- browser storage can only be read after hydration.
  setLanguage(stored);
 },[]);
 useEffect(()=>{
  if(!userId||applied.current===userId||remote.me===undefined)return;
  applied.current=userId;
  const picked=signInChoice.current;
  if(picked){
   signInChoice.current=null;try{localStorage.removeItem(SIGN_IN_LANGUAGE)}catch{}
   if(remote.me&&picked!==saved)remote.personal.setLanguage(picked).catch(()=>{});
   return;
  }
  if(saved&&!chosen.current)setLanguage(saved);
 },[userId,saved,remote.me,remote.personal]);
 useEffect(()=>{document.documentElement.lang=lang;document.documentElement.dir=lang==='he'?'rtl':'ltr'},[lang]);
 const personal=remote.personal;
 // Changing the language saves it in the background; a failure keeps the choice here.
 const setLang=(next:'en'|'he')=>{
  chosen.current=true;setLanguage(next);
  if(!userId){signInChoice.current=next;try{localStorage.setItem(SIGN_IN_LANGUAGE,next)}catch{}return;}
  if(next!==remote.me?.language)personal.setLanguage(next).catch(()=>{});
 };
 return remote.me?.status==='approved'&&remote.me.active&&remote.state
  ?<RotaWorkspace key={remote.user!.id} remote={remote} lang={lang} setLang={setLang}/>
  :<AccessScreen remote={remote} lang={lang} setLang={setLang}/>;
}
