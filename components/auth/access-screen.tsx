'use client';
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {Clock, LogOut, RefreshCw, UserRoundX} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Logo} from '@/components/brand/logo';
import {EnvironmentBadge,InspectionWarning} from '@/components/environment-indicator';
import type {TeamWorkspace} from '@/hooks/use-team-workspace';
import {StartupSkeleton} from './startup-skeleton';
import {APP_NAME} from '@/lib/brand';

/** Sign-in, and the waiting / declined / inactive states before the workspace (owner round 4,
 * 2026-11-07): centred on phone and PC within the safe areas, a header with the logo, the name
 * and one line over the brand glow, one main button with everything else as quieter text below,
 * and a language switch in the corner that works before sign-in and is remembered after it. */
export function AccessScreen({remote,lang,setLang}:{remote:TeamWorkspace;lang:'en'|'he';setLang:(lang:'en'|'he')=>void}){
 const t=(en:string,he:string)=>lang==='en'?en:he;
 const [email,setEmail]=useState('admin@duty.local'),[password,setPassword]=useState(''),[returnUrl,setReturnUrl]=useState('');
 const page=useRef<HTMLElement>(null);
 useEffect(()=>{try{localStorage.removeItem('duty-demo-v1')}catch{}},[]);
 // The page keeps the height it opened with while a field has focus, so the phone keyboard
 // (the viewport resizes to it) scrolls the form into view instead of re-centring it.
 useLayoutEffect(()=>{
  const node=page.current;if(!node)return;
  let width=innerWidth;
  const set=()=>node.style.setProperty('--access-h',`${innerHeight}px`);
  const resize=()=>{const typing=document.activeElement instanceof HTMLInputElement;if(innerWidth!==width||!typing||innerHeight>parseFloat(node.style.getPropertyValue('--access-h'))){width=innerWidth;set();}};
  set();addEventListener('resize',resize);return()=>removeEventListener('resize',resize);
 },[remote.loading]);
 const pending=!!remote.user,rejected=remote.me?.status==='rejected',inactive=remote.me?.status==='approved'&&!remote.me.active,local=remote.environment?.target==='local';
 if(remote.loading)return <StartupSkeleton lang={lang} environment={remote.environment}/>;
 const tagline=t('Your team’s duty rota','לוח התורנויות של הצוות');
 const title=rejected?t('Request declined','הבקשה נדחתה'):inactive?t('Membership inactive','החברות אינה פעילה'):t('Waiting for approval','ממתין לאישור');
 const copy=rejected?t('An admin declined this account.','מנהל דחה את החשבון הזה.'):inactive?t('An admin deactivated this membership.','מנהל השבית את החברות הזו.'):t('An admin approves new members. Check back soon.','מנהל מאשר חברים חדשים. כדאי לבדוק שוב בקרוב.');
 return <main ref={page} className="access-page" dir={lang==='he'?'rtl':'ltr'}>
  <div className="access-corner">
   <EnvironmentBadge environment={remote.environment}/>
   <div className="access-language" role="group" aria-label={t('Language','שפה')}>
    {(['en','he'] as const).map(l=><button key={l} type="button" lang={l} aria-pressed={lang===l} onClick={()=>{if(l!==lang)setLang(l)}}>{l==='en'?'English':'עברית'}</button>)}
   </div>
  </div>
  <div className="access-stack">
   <header className="access-hero">
    <Logo size={56}/>
    <span className="access-name">{APP_NAME.toLowerCase()}</span>
    {pending?<p className="access-tagline">{tagline}</p>:<h1 className="access-tagline">{tagline}</h1>}
   </header>
   <section className="access-card" aria-live="polite">
    <InspectionWarning environment={remote.environment} lang={lang}/>
    {pending&&<>
     <span className="access-state" data-tone={rejected||inactive?'danger':'warn'} aria-hidden="true">{rejected||inactive?<UserRoundX/>:<Clock/>}</span>
     <h1>{title}</h1>
     <p>{copy}</p>
     {remote.user?.email&&<small className="access-email">{remote.user.email}</small>}
    </>}
    {remote.error&&<div className="note-line" data-tone="danger" role="alert">{remote.error}</div>}
    {pending?<>
     <Button size="lg" className="access-main" onClick={()=>remote.refresh().catch(()=>{})}><RefreshCw/>{t('Check approval','בדיקת אישור')}</Button>
     <button type="button" className="access-quiet-action" onClick={()=>remote.signOut()}><LogOut/>{t('Sign out','יציאה')}</button>
    </>:local?<>
     <form className="local-login" onSubmit={async e=>{e.preventDefault();await remote.signInLocal(email,password);setPassword('')}}>
      <label className="field-label">{t('Email','דוא״ל')}<input type="email" autoComplete="username" required value={email} onChange={e=>setEmail(e.target.value)}/></label>
      <label className="field-label">{t('Password','סיסמה')}<input type="password" autoComplete="current-password" required value={password} onChange={e=>setPassword(e.target.value)}/></label>
      <Button type="submit" size="lg" className="access-main">{t('Sign in locally','התחברות מקומית')}</Button>
     </form>
     <p className="access-quiet">{t('Sign in with a local test account.','התחברות עם חשבון בדיקה מקומי.')}</p>
    </>:<>
     <Button size="lg" className="access-main" disabled={!remote.environment} onClick={()=>remote.signIn()}><GoogleMark/>{t('Continue with Google','המשך עם גוגל')}</Button>
     <p className="access-quiet">{t('New here? Signing in asks an admin to let you join.','חדשים כאן? ההתחברות שולחת למנהל בקשה להצטרף.')}</p>
    </>}
    {!pending&&remote.readOnly&&remote.environment&&<form className="local-login access-inspection" onSubmit={async e=>{e.preventDefault();await remote.completeInspection(returnUrl);setReturnUrl('')}}>
     <p className="access-quiet">{t('Google opens in a new tab and returns to the deployed Production site. Copy that return URL here to finish this localhost PKCE login. Only existing approved members can inspect; no join request is created.','גוגל נפתח בלשונית חדשה וחוזר לאתר Production. העתיקו לכאן את כתובת החזרה להשלמת ההתחברות המקומית. רק חברים מאושרים קיימים יכולים לצפות; לא נוצרת בקשת הצטרפות.')}</p>
     <label className="field-label">{t('Google return URL','כתובת חזרה מגוגל')}<input type="url" autoComplete="off" required value={returnUrl} onChange={e=>setReturnUrl(e.target.value)}/></label>
     <Button type="submit" variant="secondary">{t('Complete inspection login','השלמת התחברות לצפייה')}</Button>
    </form>}
   </section>
  </div>
 </main>;
}

function GoogleMark(){
 return <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5"><path fill="#EA4335" d="M12 10.2v3.9h5.4c-.2 1.3-1.6 3.9-5.4 3.9-3.3 0-5.9-2.7-5.9-6s2.6-6 5.9-6c1.9 0 3.1.8 3.8 1.5l2.6-2.5C16.8 3.4 14.6 2.4 12 2.4 6.7 2.4 2.4 6.7 2.4 12s4.3 9.6 9.6 9.6c5.5 0 9.2-3.9 9.2-9.4 0-.6-.1-1.1-.2-1.6H12z"/></svg>;
}
