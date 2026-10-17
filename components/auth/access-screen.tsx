'use client';
import {useEffect,useState} from 'react';
import {Button} from '@/components/ui/button';
import {EnvironmentBadge,InspectionWarning} from '@/components/environment-indicator';
import type {TeamWorkspace} from '@/hooks/use-team-workspace';
import {StartupSkeleton} from './startup-skeleton';
export function AccessScreen({remote,lang,setLang}:{remote:TeamWorkspace;lang:'en'|'he';setLang:(lang:'en'|'he')=>void}){
 const t=(en:string,he:string)=>lang==='en'?en:he;
 const [email,setEmail]=useState('admin@duty.local'),[password,setPassword]=useState(''),[returnUrl,setReturnUrl]=useState('');
 useEffect(()=>{try{localStorage.removeItem('duty-demo-v1')}catch{}},[]);
 const pending=!!remote.user,rejected=remote.me?.status==='rejected',inactive=remote.me?.status==='approved'&&!remote.me.active,local=remote.environment?.target==='local';
 if(remote.loading)return <StartupSkeleton lang={lang} environment={remote.environment}/>;
 return <main className="access-page" dir={lang==='he'?'rtl':'ltr'}><section className="access-card">
  <div className="access-top"><span className="brand"><span className="brand-symbol">d<span>·</span></span> duty</span><EnvironmentBadge environment={remote.environment}/><Button variant="ghost" onClick={()=>setLang(lang==='en'?'he':'en')}>{lang==='en'?'עברית':'English'}</Button></div>
  <InspectionWarning environment={remote.environment} lang={lang}/>
  <h1>{pending?rejected?t('Request declined','הבקשה נדחתה'):inactive?t('Membership inactive','החברות אינה פעילה'):t('Waiting for approval','ממתין לאישור'):t('Your team’s duty calendar','לוח התורנויות של הצוות')}</h1>
  <p>{pending?t('Your manager must approve your membership before you can enter the team workspace.','המנהל צריך לאשר את חברותך לפני הכניסה לסביבת הצוות.'):local?t('Sign in with an isolated local test account.','התחברות עם חשבון בדיקה מקומי מבודד.'):t('Sign in with Google to request access.','יש להתחבר עם גוגל כדי לבקש גישה.')}</p>
  {remote.user?.email&&<small>{remote.user.email}</small>}{remote.error&&<div className="warning-note" role="alert">{remote.error}</div>}
  {!remote.loading&&(pending?<div className="access-actions"><Button onClick={()=>remote.refresh().catch(()=>{})}>{t('Check approval','בדיקת אישור')}</Button><Button variant="outline" onClick={()=>remote.signOut()}>{t('Sign out','יציאה')}</Button></div>:local?
   <form className="local-login" onSubmit={async e=>{e.preventDefault();await remote.signInLocal(email,password);setPassword('')}}>
    <label className="field-label">{t('Email','דוא״ל')}<input type="email" autoComplete="username" required value={email} onChange={e=>setEmail(e.target.value)}/></label>
    <label className="field-label">{t('Password','סיסמה')}<input type="password" autoComplete="current-password" required value={password} onChange={e=>setPassword(e.target.value)}/></label>
    <Button type="submit">{t('Sign in locally','התחברות מקומית')}</Button>
   </form>:<Button disabled={!remote.environment} onClick={()=>remote.signIn()}>{t('Continue with Google','המשך עם גוגל')}</Button>)}
  {!pending&&remote.readOnly&&remote.environment&&<form className="local-login" onSubmit={async e=>{e.preventDefault();await remote.completeInspection(returnUrl);setReturnUrl('')}}>
   <p>{t('Google opens in a new tab and returns to the deployed Production site. Copy that return URL here to finish this localhost PKCE login. Only existing approved members can inspect; no join request is created.','גוגל נפתח בלשונית חדשה וחוזר לאתר Production. העתיקו לכאן את כתובת החזרה להשלמת ההתחברות המקומית. רק חברים מאושרים קיימים יכולים לצפות; לא נוצרת בקשת הצטרפות.')}</p>
   <label className="field-label">{t('Google return URL','כתובת חזרה מגוגל')}<input type="url" autoComplete="off" required value={returnUrl} onChange={e=>setReturnUrl(e.target.value)}/></label>
   <Button type="submit">{t('Complete inspection login','השלמת התחברות לצפייה')}</Button>
  </form>}
 </section></main>;
}
