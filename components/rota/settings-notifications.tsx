'use client';
import {Fragment, useCallback, useEffect, useRef, useState} from 'react';
import {BellRing, BellOff} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Checkbox} from '@/components/ui/checkbox';
import type {TeamWorkspace} from '@/hooks/use-team-workspace';
import {getVapidPublicKey} from '@/lib/supabase/client';
import {currentSubscription, describe, disablePush, enablePush, pushStatus, type PushStatus} from '@/lib/push/browser';
import type {NotificationSettings, NotificationState, Switch} from '@/lib/push/settings';
import {TimeWheels} from './time-wheel';
import {userMessage} from '@/lib/messages';

type TimeKey = 'eveningTime' | 'morningTime';

/** Notifications in the settings screen (decision 2026-11-06): this device's web push
 * subscription and the member's own switches and reminder times (Israel time). */
export function NotificationSettingsPanel({remote, lang, open}: {remote: TeamWorkspace; lang: 'en' | 'he'; open: boolean}) {
  const t = (en: string, he: string) => lang === 'he' ? he : en;
  const [status, setStatus] = useState<PushStatus | 'loading'>('loading');
  const [settings, setSettings] = useState<NotificationState | null>(null);
  const [loadError, setLoadError] = useState(''), [error, setError] = useState(''), [note, setNote] = useState('');
  const [busy, setBusy] = useState<'' | 'enable' | 'disable' | 'save'>('');
  // Reminder times (decision 2026-11-06): one row's wheels open at a time; a settled wheel saves
  // after a short pause (hour and minute together), shows "Saved", and puts the time back on failure.
  const [openTime, setOpenTime] = useState<TimeKey | null>(null), [savedTime, setSavedTime] = useState<TimeKey | null>(null);
  const settingsRef = useRef<NotificationState | null>(null), timeBase = useRef<NotificationState | null>(null), timeTimer = useRef(0), timeSeq = useRef(0);
  useEffect(() => {settingsRef.current = settings;});
  useEffect(() => () => window.clearTimeout(timeTimer.current), []);
  useEffect(() => {
    if (!savedTime) return;
    const timer = window.setTimeout(() => setSavedTime(null), 2500);
    return () => window.clearTimeout(timer);
  }, [savedTime]);
  // Esc closes the open wheels; the settings sheet stays open (settings-screen.tsx).
  useEffect(() => {
    if (!openTime) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpenTime(null);
      document.getElementById(`settings-${openTime}-button`)?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [openTime]);
  const readOnly = remote.readOnly, personal = remote.personal, vapid = useRef<string | null>(null);
  const [wasOpen, setWasOpen] = useState(false);
  // Each opening starts without the last visit's messages.
  if (wasOpen !== open) {setWasOpen(open); if (open) {setError(''); setNote('');}}
  const say = (e: unknown) => userMessage(e instanceof Error ? e.message : String((e as {message?: unknown})?.message ?? e), t);

  // This device's state and the member's switches; in read-only inspection only the device.
  const fetchState = useCallback(async () => {
    const key = await getVapidPublicKey(), next = await pushStatus(key);
    if (readOnly) return {key, next, state: null};
    let state = await personal.notificationSettings();
    // This device is subscribed: make sure it is registered for whoever is signed in now.
    const subscription = next === 'on' ? await currentSubscription() : null;
    if (subscription) state = await personal.saveDevice(describe(subscription)).then(() => personal.notificationSettings()).catch(() => state);
    return {key, next, state};
  }, [personal, readOnly]);
  const apply = useCallback((loaded: Awaited<ReturnType<typeof fetchState>>) => {
    vapid.current = loaded.key; setStatus(loaded.next); setLoadError('');
    if (loaded.state) setSettings(loaded.state);
  }, []);
  const failed = useCallback((e: unknown) => setLoadError(userMessage(e instanceof Error ? e.message : String(e), lang === 'he' ? (_en, he) => he : en => en)), [lang]);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    fetchState().then(loaded => {if (alive) apply(loaded);}, e => {if (alive) failed(e);});
    return () => {alive = false;};
  }, [open, fetchState, apply, failed]);
  const load = () => fetchState().then(apply, failed);

  async function save(change: Partial<NotificationSettings>) {
    if (!settings || busy) return;
    const previous = settings, next = {...settings, ...change};
    setSettings(next); setBusy('save'); setError(''); setNote('');
    try {
      const saved = await personal.saveNotificationSettings(next);
      setSettings(saved);
    } catch (e) {setSettings(previous); setError(say(e));}
    finally {setBusy('');}
  }
  function queueTime(key: TimeKey, value: string) {
    const current = settingsRef.current;
    if (!current || current[key] === value) return;
    if (!timeBase.current) timeBase.current = current;
    const next = {...current, [key]: value};
    settingsRef.current = next; setSettings(next); setSavedTime(null); setError(''); setNote('');
    const seq = ++timeSeq.current;
    window.clearTimeout(timeTimer.current);
    timeTimer.current = window.setTimeout(async () => {
      const base = timeBase.current ?? current;
      timeBase.current = null;
      setBusy('save');
      try {
        const saved = await personal.saveNotificationSettings(next);
        if (seq === timeSeq.current) {setSettings(saved); setSavedTime(key);}
      } catch (e) {
        if (seq === timeSeq.current) {
          setSettings(base);
          setError(t(`The time wasn’t saved, so it is back to ${base[key]}.`, `השעה לא נשמרה ולכן חזרה ל־${base[key]}.`) + ' ' + say(e));
        }
      } finally {setBusy('');}
    }, 600);
  }
  async function enable() {
    if (!vapid.current) return;
    setBusy('enable'); setError(''); setNote('');
    try {
      await enablePush(vapid.current, device => personal.saveDevice(device));
      setStatus('on');
      setSettings(await personal.notificationSettings());
    } catch (e) {setError(say(e)); setStatus(await pushStatus(vapid.current).catch(() => 'unsupported' as const));}
    finally {setBusy('');}
  }
  async function disable() {
    setBusy('disable'); setError(''); setNote('');
    try {
      await disablePush(endpoint => personal.removeDevice(endpoint));
      setStatus('off');
      setSettings(await personal.notificationSettings());
    } catch (e) {setError(say(e));}
    finally {setBusy('');}
  }

  const statusText: Record<PushStatus | 'loading', string> = {
    loading: t('Checking this device…', 'בודק את המכשיר…'),
    on: t('Notifications are on for this device.', 'ההתראות פועלות במכשיר הזה.'),
    off: t('Notifications are off on this device.', 'ההתראות כבויות במכשיר הזה.'),
    install: t('On iPhone, notifications work only in Duty from the Home Screen. Add it there first (see below).', 'באייפון, התראות פועלות רק ב־Duty ממסך הבית. יש להוסיף אותו קודם (הסבר למטה).'),
    unsupported: t('This browser can’t receive notifications. Use Chrome on Android, or Duty from the Home Screen on iPhone (iOS 16.4 or later).', 'הדפדפן הזה לא יכול לקבל התראות. יש להשתמש ב־Chrome באנדרואיד, או ב־Duty ממסך הבית באייפון (iOS 16.4 ומעלה).'),
    blocked: t('Notifications are blocked for Duty. Allow them in the browser or phone settings, then come back here.', 'ההתראות חסומות עבור Duty. יש לאפשר אותן בהגדרות הדפדפן או הטלפון ולחזור לכאן.'),
    unconfigured: t('Notifications aren’t set up on this server yet. Ask an admin.', 'ההתראות עדיין לא הוגדרו בשרת הזה. יש לפנות למנהל.'),
  };
  const canEnable = status === 'off' && !readOnly && !busy;
  const rows: {key: Switch; label: string; help: string; time?: 'eveningTime' | 'morningTime'}[] = [
    {key: 'deadlines', label: t('Constraint deadline', 'מועד אחרון לאילוצים'), help: t('3 days before; 1 day before if you haven’t entered any.', '3 ימים לפני; יום לפני אם עדיין לא הזנת אילוצים.')},
    {key: 'published', label: t('A month is published', 'חודש פורסם'), help: t('When a new schedule comes out.', 'כשלוח חדש מתפרסם.')},
    {key: 'swaps', label: t('Swap requests', 'בקשות החלפה'), help: t('New, accepted, declined or approved swaps you’re part of.', 'החלפות שלך: חדשות, שהתקבלו, שנדחו או שאושרו.')},
    {key: 'edits', label: t('Changes to my published duties', 'שינויים בתורנויות שלי שפורסמו'), help: t('When an admin changes one of your duties.', 'כשמנהל משנה אחת מהתורנויות שלך.')},
    {key: 'evening', label: t('Evening before my duty', 'ערב לפני התורנות'), help: t('Reminder the day before, at', 'תזכורת יום לפני, בשעה'), time: 'eveningTime'},
    {key: 'morning', label: t('Morning of my duty', 'בוקר התורנות'), help: t('Reminder on the day, at', 'תזכורת ביום עצמו, בשעה'), time: 'morningTime'},
    ...(remote.isAdmin ? [{key: 'members' as const, label: t('New member waiting', 'חבר צוות חדש ממתין'), help: t('Admins: someone signed up and needs approval.', 'למנהלים: מישהו נרשם וממתין לאישור.')}] : []),
  ];
  const locked = readOnly || !settings || !!busy;

  return <section className="settings-section settings-notifications" aria-labelledby="settings-notifications-title" aria-busy={!!busy || status === 'loading'}>
    <h3 id="settings-notifications-title">{t('Notifications', 'התראות')}</h3>
    <div className={'settings-device ' + status}>
      <p role="status">{readOnly ? t('Notifications can’t be changed in read-only inspection.', 'אי אפשר לשנות התראות בבדיקה לקריאה בלבד.') : statusText[status]}
        {status === 'on' && settings && settings.devices > 1 && ' ' + t(`${settings.devices} of your devices get them.`, `${settings.devices} מהמכשירים שלך מקבלים אותן.`)}</p>
      <div className="settings-actions">
        {status === 'on'
          ? <Button variant="outline" disabled={readOnly || !!busy} onClick={disable}><BellOff/>{busy === 'disable' ? t('Turning off…', 'מכבה…') : t('Turn off on this device', 'כיבוי במכשיר הזה')}</Button>
          : <Button disabled={!canEnable} onClick={enable} aria-describedby="settings-iphone-help"><BellRing/>{busy === 'enable' ? t('Enabling…', 'מפעיל…') : t('Enable notifications', 'הפעלת התראות')}</Button>}
      </div>
    </div>
    {status !== 'on' && <div className="settings-help" id="settings-iphone-help">
      <strong>{t('iPhone: Add to Home Screen first', 'אייפון: קודם להוסיף למסך הבית')}</strong>
      <p>{t('In Safari, tap Share, then “Add to Home Screen”. Open Duty from the Home Screen icon and enable notifications here. Needs iOS 16.4 or later.',
        'ב־Safari יש להקיש על „שיתוף” ואז „הוספה למסך הבית”. יש לפתוח את Duty מהסמל במסך הבית ולהפעיל כאן התראות. נדרש iOS 16.4 ומעלה.')}</p>
    </div>}
    {loadError && <p className="warning-note" role="alert">{loadError} <Button variant="ghost" size="sm" onClick={() => void load()}>{t('Try again', 'ניסיון נוסף')}</Button></p>}
    {!readOnly && <fieldset className="settings-switches" disabled={!settings}>
      <legend>{t('Notify me about', 'להודיע לי על')}</legend>
      {rows.map(row => {
        const time = row.time, on = !!settings?.[row.key], expanded = !!time && openTime === time && on;
        return <Fragment key={row.key}>
          <div className="settings-switch">
            <label className="check-label">
              <Checkbox disabled={locked} checked={on} onCheckedChange={value => void save({[row.key]: value === true})}/>
              <span><strong>{row.label}</strong><small>{row.help}{time && ':'}</small></span>
            </label>
            {time && <div className="settings-time-cell">
              {savedTime === time && <span className="settings-saved" role="status">{t('Saved', 'נשמר')}</span>}
              {/* Quarter hours: the scheduler runs every 15 minutes (decision 2026-11-06). */}
              <button type="button" id={`settings-${time}-button`} className="settings-time" dir="ltr" disabled={!settings || !on}
                aria-label={`${row.label} · ${t('time', 'שעה')} ${settings?.[time] ?? ''}`} aria-expanded={expanded} aria-controls={`settings-${time}-wheels`}
                onClick={() => setOpenTime(expanded ? null : time)}>{settings?.[time] ?? '––:––'}</button>
            </div>}
          </div>
          {time && expanded && settings && <TimeWheels id={`settings-${time}-wheels`} value={settings[time]} onChange={value => queueTime(time, value)}
            labels={{group: `${row.label} · ${t('time', 'שעה')}`, hour: `${t('Hour', 'שעה')} · ${row.label}`, minute: `${t('Minutes', 'דקות')} · ${row.label}`}}/>}
        </Fragment>;
      })}
      <p className="muted-copy">{t('Times are Israel time. These choices apply to all your devices.', 'השעות לפי שעון ישראל. הבחירות חלות על כל המכשירים שלך.')}</p>
    </fieldset>}
    {error && <p className="warning-note" role="alert">{error}</p>}
    {note && <p className="settings-note" role="status">{note}</p>}
  </section>;
}
