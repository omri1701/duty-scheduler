'use client';
import {useState} from 'react';
import {LogOut} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle} from '@/components/ui/dialog';
import type {TeamWorkspace} from '@/hooks/use-team-workspace';
import {forgetDevice} from '@/lib/push/browser';
import {userMessage} from '@/lib/messages';
import {NotificationSettingsPanel} from './settings-notifications';
import {CalendarSettings} from './settings-calendar';

/** The profile button's settings screen (decision 2026-11-06): name, language,
 * notifications, the Calendar slot and sign-out. A full-screen sheet on phones. */
export function SettingsScreen({remote, open, onOpenChange, lang, setLang}: {remote: TeamWorkspace; open: boolean; onOpenChange: (open: boolean) => void;
  lang: 'en' | 'he'; setLang: (lang: 'en' | 'he') => void}) {
  const t = (en: string, he: string) => lang === 'he' ? he : en;
  const [name, setName] = useState(open ? remote.me?.name ?? '' : ''), [error, setError] = useState(''), [saved, setSaved] = useState(false);
  const [wasOpen, setWasOpen] = useState(open), [leaving, setLeaving] = useState(false);
  // Capture the latest saved name on opening, without overwriting an in-progress edit.
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {setName(remote.me?.name ?? ''); setError(''); setSaved(false);}
  }
  const unchanged = name.trim() === (remote.me?.name ?? '').trim();
  async function rename() {
    setError(''); setSaved(false);
    try {await remote.rename(name.trim()); setSaved(true);} catch (e) {setError(userMessage((e as Error).message, t));}
  }
  async function signOut() {
    setLeaving(true);
    // This device stops receiving the member's notifications; never blocks signing out.
    if (!remote.readOnly) await forgetDevice(endpoint => remote.personal.removeDevice(endpoint));
    await remote.signOut();
    setLeaving(false);
  }
  return <Dialog open={open} onOpenChange={next => {if (!leaving) onOpenChange(next);}}>
    <DialogContent className="settings-sheet" dir={lang === 'he' ? 'rtl' : 'ltr'} closeDisabled={leaving}
      // Focus the sheet itself, not the name field: on a phone that would open the keyboard.
      onOpenAutoFocus={event => {event.preventDefault(); (event.currentTarget as HTMLElement | null)?.focus();}}
      onCloseAutoFocus={event => {event.preventDefault(); document.querySelector<HTMLButtonElement>('[data-settings-button]')?.focus();}}>
      <DialogHeader><DialogTitle>{t('Settings', 'הגדרות')}</DialogTitle><DialogDescription>{remote.me?.email}</DialogDescription></DialogHeader>
      <section className="settings-section" aria-labelledby="settings-profile-title">
        <h3 id="settings-profile-title">{t('Profile', 'פרופיל')}</h3>
        <label className="field-label">{t('Display name', 'שם לתצוגה')}<input disabled={remote.readOnly} maxLength={80} value={name} onChange={e => {setName(e.target.value); setSaved(false);}}
          onKeyDown={e => {if (e.key === 'Enter' && name.trim() && !unchanged && !remote.saving && !remote.readOnly) void rename();}}/></label>
        <p className="muted-copy">{t('This name appears on the team calendar.', 'השם הזה יופיע בלוח התורנויות של הצוות.')}</p>
        {error && <p className="warning-note" role="alert">{error}</p>}
        <div className="settings-actions">
          <Button disabled={remote.readOnly || remote.saving || !name.trim() || unchanged} onClick={rename}>{t('Save name', 'שמירת השם')}</Button>
          {saved && <span className="settings-note" role="status">{t('Saved', 'נשמר')}</span>}
        </div>
      </section>
      <section className="settings-section" aria-labelledby="settings-language-title">
        <h3 id="settings-language-title">{t('Language', 'שפה')}</h3>
        <div className="settings-choice" role="radiogroup" aria-labelledby="settings-language-title">
          {([['en', 'English'], ['he', 'עברית']] as const).map(([value, label]) => <label key={value} className={lang === value ? 'selected' : undefined}>
            <input type="radio" name="settings-language" value={value} checked={lang === value} onChange={() => setLang(value)}/>
            <span lang={value}>{label}</span>
          </label>)}
        </div>
        <p className="muted-copy">{t('Saved to your account: used on your other devices and in your notifications.', 'נשמרת בחשבון שלך: משמשת במכשירים האחרים שלך ובהתראות.')}</p>
      </section>
      <NotificationSettingsPanel remote={remote} lang={lang} open={open}/>
      <CalendarSettings remote={remote} lang={lang}/>
      <section className="settings-section settings-sign-out" aria-label={t('Sign out', 'יציאה')}>
        <Button variant="outline" disabled={leaving} onClick={signOut}><LogOut/>{leaving ? t('Signing out…', 'מתנתק…') : t('Sign out', 'יציאה')}</Button>
      </section>
    </DialogContent>
  </Dialog>;
}
