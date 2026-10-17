'use client';
import {useEffect,useState} from 'react';
import {useTeamWorkspace} from '@/hooks/use-team-workspace';
import {RotaWorkspace} from '@/components/rota/workspace';
import {AccessScreen} from '@/components/auth/access-screen';
export default function Home(){
 const remote=useTeamWorkspace(),[lang,setLang]=useState<'en'|'he'>('en');
 useEffect(()=>{document.documentElement.lang=lang;document.documentElement.dir=lang==='he'?'rtl':'ltr'},[lang]);
 return remote.me?.status==='approved'&&remote.me.active&&remote.state
  ?<RotaWorkspace key={remote.user!.id} remote={remote} lang={lang} setLang={setLang}/>
  :<AccessScreen remote={remote} lang={lang} setLang={setLang}/>;
}
