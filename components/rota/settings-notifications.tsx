'use client';
import {Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {BellRing, BellOff, Info} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Card, SectionTitle} from '@/components/ui/card';
import {Switch} from '@/components/ui/switch';
import type {TeamWorkspace} from '@/hooks/use-team-workspace';
import {getVapidPublicKey} from '@/lib/supabase/client';
import {currentSubscription, describe, disablePush, enablePush, pushStatus, type PushStatus} from '@/lib/push/browser';
import type {NotificationSettings, NotificationState, Switch as SwitchKey} from '@/lib/push/settings';
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
  // Reminder times: one row's wheels open at a time; a settled wheel saves after a short pause
  // (hour and minute together), shows "Saved", and puts the time back on failure.
  const [openTime, setOpenTime] = useState<TimeKey | null>(null), [savedTime, setSavedTime] = useState<TimeKey | null>(null);
  const settingsRef = useRef<NotificationState | null>(null), timeBase = useRef<NotificationState | null>(null), timeTimer = useRef(0), timeSeq = useRef(0);
  useLayoutEffect(() => {settingsRef.current = settings;});
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
    on: t('On for this device', 'פועלות במכשיר הזה'),
    off: t('Off on this device', 'כבויות במכשיר הזה'),
    install: t('On iPhone, add the app to the Home Screen first', 'באייפון, קודם להוסיף את האפליקציה למסך הבית'),
    unsupported: t('This browser can’t receive notifications', 'הדפדפן הזה לא יכול לקבל התראות'),
    blocked: t('Blocked in the browser or phone settings', 'חסומות בהגדרות הדפדפן או הטלפון'),
    unconfigured: t('Not set up on this server yet', 'עדיין לא הוגדרו בשרת הזה'),
  };
  const canEnable = status === 'off' && !readOnly && !busy;
  const rows: {key: SwitchKey; label: string; help: string; time?: TimeKey}[] = [
    {key: 'deadlines', label: t('Constraint deadline', 'מועד אחרון לאילוצים'), help: t('3 days before, and 1 day before if you entered none', '3 ימים לפני, ויום לפני אם לא הזנת')},
    {key: 'published', label: t('Month published', 'חודש פורסם'), help: ''},
    {key: 'swaps', label: t('Swap requests', 'בקשות החלפה'), help: ''},
    {key: 'edits', label: t('Changes to my duties', 'שינויים בתורנויות שלי'), help: ''},
    {key: 'evening', label: t('Evening before', 'ערב לפני'), help: '', time: 'eveningTime'},
    {key: 'morning', label: t('Morning of', 'בבוקר'), help: '', time: 'morningTime'},
    ...(remote.isAdmin ? [{key: 'members' as const, label: t('New member waiting', 'חבר צוות חדש ממתין'), help: ''}] : []),
  ];
  const locked = readOnly || !settings || !!busy;

  return <section className="settings-section settings-notifications" aria-labelledby="settings-notifications-title" aria-busy={!!busy || status === 'loading'}>
    <SectionTitle><span id="settings-notifications-title">{t('Notifications', 'התראות')}</span></SectionTitle>
    <Card inset>
      <div className={'row settings-device ' + status}>
        <span className="row-lead"><span className="row-icon" data-tone={status === 'on' ? 'ok' : status === 'loading' || status === 'off' ? 'neutral' : 'warn'}>{status === 'on' ? <BellRing/> : <BellOff/>}</span></span>
        <span className="row-body"><span className="row-title">{t('This device', 'המכשיר הזה')}</span><span className="row-subtitle" role="status">{readOnly ? t('Read-only inspection', 'בדיקה לקריאה בלבד') : statusText[status]}{status === 'on' && settings && settings.devices > 1 && ` · ${t(`${settings.devices} devices`, `${settings.devices} מכשירים`)}`}</span></span>
        <span className="row-trail">
          {status === 'on'
            ? <Button variant="secondary" size="sm" disabled={readOnly || !!busy} onClick={disable}>{busy === 'disable' ? t('Turning off…', 'מכבה…') : t('Turn off', 'כיבוי')}</Button>
            : <Button size="sm" disabled={!canEnable} onClick={enable} aria-describedby={status === 'install' ? 'settings-iphone-help' : undefined}>{busy === 'enable' ? t('Enabling…', 'מפעיל…') : t('Enable', 'הפעלה')}</Button>}
        </span>
      </div>
      {status === 'install' && <p className="row row-note" id="settings-iphone-help"><Info aria-hidden="true"/>{t('In Safari: Share, then “Add to Home Screen”, then open the app from there (iOS 16.4+).', 'ב־Safari: שיתוף, ואז „הוספה למסך הבית”, ואז לפתוח את האפליקציה משם (iOS 16.4 ומעלה).')}</p>}
      {loadError && <p className="row row-note" data-tone="danger" role="alert">{loadError} <Button variant="ghost" size="xs" onClick={() => void load()}>{t('Try again', 'ניסיון נוסף')}</Button></p>}
    </Card>
    {!readOnly && <fieldset className="settings-switches" disabled={!settings}>
      <legend className="sr-only">{t('Notify me about', 'להודיע לי על')}</legend>
      <Card inset>
        {rows.map(row => {
          const time = row.time, on = !!settings?.[row.key], expanded = !!time && openTime === time && on;
          const id = `settings-switch-${row.key}`;
          return <Fragment key={row.key}>
            <div className="row settings-switch">
              <span className="row-body"><label className="row-title" htmlFor={id}>{row.label}</label>{row.help && <span className="row-subtitle">{row.help}</span>}</span>
              <span className="row-trail">
                {time && <span className="settings-time-cell">
                  {savedTime === time && <span className="settings-saved" role="status">{t('Saved', 'נשמר')}</span>}
                  {/* Quarter hours: the scheduler runs every 15 minutes (decision 2026-11-06). */}
                  <button type="button" id={`settings-${time}-button`} className="settings-time" dir="ltr" disabled={!settings || !on}
                    aria-label={`${row.label} · ${t('time', 'שעה')} ${settings?.[time] ?? ''}`} aria-expanded={expanded} aria-controls={`settings-${time}-wheels`}
                    onClick={() => setOpenTime(expanded ? null : time)}>{settings?.[time] ?? '––:––'}</button>
                </span>}
                <Switch id={id} disabled={locked} checked={on} aria-label={row.label} onCheckedChange={value => void save({[row.key]: value === true})}/>
              </span>
            </div>
            {time && expanded && settings && <TimeWheels id={`settings-${time}-wheels`} value={settings[time]} onChange={value => queueTime(time, value)}
              labels={{group: `${row.label} · ${t('time', 'שעה')}`, hour: `${t('Hour', 'שעה')} · ${row.label}`, minute: `${t('Minutes', 'דקות')} · ${row.label}`}}/>}
          </Fragment>;
        })}
      </Card>
      <p className="settings-footnote">{t('Israel time · all your devices', 'שעון ישראל · כל המכשירים שלך')}</p>
    </fieldset>}
    {error && <p className="note-line" data-tone="danger" role="alert">{error}</p>}
    {note && <p className="note-line" role="status">{note}</p>}
  </section>;
}
