'use client';
// "Subscribe to my calendar" (decision 2026-11-06): a self-contained block that moves into the
// settings screen's Calendar section as is. It needs only the language, the member and whether
// writes are allowed; it talks to the checked calendar RPCs itself.
import {useEffect, useRef, useState} from 'react';
import {CalendarPlus, Copy, RefreshCw} from 'lucide-react';
import {toast} from 'sonner';
import {Button} from '@/components/ui/button';
import {getSupabase} from '@/lib/supabase/client';
import {calendarStatus, rememberLink, rememberedLink, resetCalendar, setCalendarLanguage, type CalendarStatus} from '@/lib/supabase/calendar';
import {feedUrl, googleUrl, webcalUrl} from '@/lib/calendar/links';
import {userMessage} from '@/lib/messages';

type Loaded = {status: CalendarStatus; token: string | null};
export function CalendarSubscription({lang, memberId, readOnly}: {lang: 'en' | 'he'; memberId: string; readOnly: boolean}) {
  const t = (en: string, he: string) => (lang === 'en' ? en : he);
  const [loaded, setLoaded] = useState<Loaded | null>(null), [busy, setBusy] = useState(false), [confirming, setConfirming] = useState(false), [error, setError] = useState('');
  const cancelRef = useRef<HTMLButtonElement>(null), resetRef = useRef<HTMLButtonElement>(null), linkRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (readOnly) return;
    let alive = true;
    (async () => {
      try {
        const client = await getSupabase(), status = await calendarStatus(client);
        if (!alive) return;
        setLoaded({status, token: status ? rememberedLink(memberId, status.createdAt) : null});
        // The feed follows the language the app is used in; the URL stays the same.
        if (status && status.language !== lang) await setCalendarLanguage(client, lang).catch(() => {});
      } catch (e) {if (alive) {setLoaded({status: null, token: null}); setError(userMessage((e as Error).message, t));}}
    })();
    return () => {alive = false};
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t only follows lang
  }, [lang, memberId, readOnly]);
  useEffect(() => {if (confirming) cancelRef.current?.focus();}, [confirming]);

  async function makeLink() {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const link = await resetCalendar(await getSupabase(), lang);
      rememberLink(memberId, link);
      setLoaded({status: {createdAt: link.createdAt, language: link.language}, token: link.token});
      setConfirming(false);
      toast.success(loaded?.status ? t('New link made. The old link no longer works.', 'נוצר קישור חדש. הקישור הקודם כבר לא עובד.') : t('Your calendar link is ready.', 'הקישור ללוח השנה שלך מוכן.'));
    } catch (e) {setError(userMessage((e as Error).message, t));}
    finally {setBusy(false);}
  }
  function cancel() {setConfirming(false); requestAnimationFrame(() => resetRef.current?.focus());}
  async function copy(url: string) {
    try {
      if (navigator.clipboard) await navigator.clipboard.writeText(url);
      // Without the async clipboard (an insecure origin), copy the selected link.
      else {linkRef.current?.select(); if (!document.execCommand('copy')) throw Error('copy');}
      toast.success(t('Link copied.', 'הקישור הועתק.'));
    } catch {linkRef.current?.select(); toast.error(t('Could not copy. Select the link and copy it manually.', 'ההעתקה נכשלה. סמנו את הקישור והעתיקו ידנית.'));}
  }

  const url = loaded?.token ? feedUrl(window.location.origin, loaded.token) : '';
  const since = loaded?.status ? new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'he-IL', {day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Jerusalem'}).format(new Date(loaded.status.createdAt)) : '';
  return <section className="calendar-subscription" aria-labelledby="calendar-subscription-title">
    <h3 id="calendar-subscription-title"><CalendarPlus aria-hidden="true"/>{t('Subscribe to my calendar', 'הרשמה ללוח השנה שלי')}</h3>
    <p className="muted-copy">{t('See your own published duties in Google or Apple Calendar. Swaps, edits and new months appear by themselves.', 'התורנויות שפורסמו לך יופיעו ביומן Google או Apple. החלפות, עריכות וחודשים חדשים יתעדכנו מעצמם.')}</p>
    {readOnly ? <p className="muted-copy">{t('Not available in this read-only view.', 'לא זמין בתצוגה לקריאה בלבד.')}</p>
      : !loaded ? <p className="muted-copy" role="status">{t('Checking your calendar link…', 'בודקים את הקישור ללוח השנה…')}</p>
      : loaded.token ? <>
        <div className="calendar-actions">
          <Button asChild><a href={webcalUrl(url)}>{t('Add to Apple Calendar', 'הוספה ליומן Apple')}</a></Button>
          <Button asChild variant="outline"><a href={googleUrl(url)} target="_blank" rel="noopener noreferrer">{t('Add to Google Calendar', 'הוספה ליומן Google')}</a></Button>
          <Button variant="outline" onClick={() => copy(url)}><Copy aria-hidden="true"/>{t('Copy link', 'העתקת הקישור')}</Button>
          <Button ref={resetRef} variant="ghost" disabled={busy || confirming} onClick={() => setConfirming(true)}><RefreshCw aria-hidden="true"/>{t('Reset link', 'איפוס הקישור')}</Button>
        </div>
        <input ref={linkRef} className="calendar-link" dir="ltr" readOnly value={url} aria-label={t('Calendar link', 'קישור ללוח השנה')} onFocus={e => e.currentTarget.select()}/>
      </>
      : loaded.status ? <>
        <p className="muted-copy">{t(`Your calendar link is active (made ${since}). It is shown only on the device that made it. To add your calendar here, reset the link; calendars using the old link stop updating.`,
          `הקישור ללוח השנה שלך פעיל (נוצר ב־${since}). הוא מוצג רק במכשיר שבו נוצר. כדי להוסיף את לוח השנה כאן, יש לאפס את הקישור; יומנים שמשתמשים בקישור הקודם יפסיקו להתעדכן.`)}</p>
        <Button ref={resetRef} variant="outline" disabled={busy || confirming} onClick={() => setConfirming(true)}><RefreshCw aria-hidden="true"/>{t('Reset link', 'איפוס הקישור')}</Button>
      </>
      : <Button disabled={busy} onClick={makeLink}><CalendarPlus aria-hidden="true"/>{t('Create my calendar link', 'יצירת קישור ללוח השנה שלי')}</Button>}
    {confirming && <div className="calendar-confirm" role="group" aria-labelledby="calendar-confirm-text">
      <p id="calendar-confirm-text">{t('Reset your calendar link? Calendars subscribed with the current link stop updating, and you add the new link again.', 'לאפס את הקישור ללוח השנה? יומנים שנרשמו עם הקישור הנוכחי יפסיקו להתעדכן, ויש להוסיף שוב את הקישור החדש.')}</p>
      <div>
        <Button variant="destructive" disabled={busy} onClick={makeLink}>{t('Reset link', 'איפוס הקישור')}</Button>
        <Button ref={cancelRef} variant="outline" disabled={busy} onClick={cancel}>{t('Cancel', 'ביטול')}</Button>
      </div>
    </div>}
    {error && <p className="warning-note" role="alert">{error}</p>}
    {!readOnly && <p className="muted-copy">{t('Google Calendar can take a few hours to show changes; Apple Calendar checks about every hour. Anyone with the link can see your duties, so reset it if it was shared by mistake.',
      'ביומן Google השינויים עשויים להופיע רק אחרי כמה שעות; יומן Apple בודק בערך פעם בשעה. כל מי שיש לו את הקישור יכול לראות את התורנויות שלך, לכן כדאי לאפס אותו אם שותף בטעות.')}</p>}
  </section>;
}
