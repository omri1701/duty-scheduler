'use client';
import {useState} from 'react';
import {Check, Download, LogOut, Moon, Sun, SunMoon} from 'lucide-react';
import {toast} from 'sonner';
import {Button} from '@/components/ui/button';
import {Sheet} from '@/components/ui/sheet';
import {Card, SectionTitle} from '@/components/ui/card';
import {ListRow} from '@/components/ui/list-row';
import {Avatar} from '@/components/ui/avatar';
import {Segmented} from '@/components/ui/segmented';
import type {TeamWorkspace} from '@/hooks/use-team-workspace';
import {useTheme} from '@/hooks/use-theme';
import {forgetDevice} from '@/lib/push/browser';
import {userMessage} from '@/lib/messages';
import {PALETTE, memberColor, memberStyle} from '@/lib/theme/palette';
import {NotificationSettingsPanel} from './settings-notifications';
import {CalendarSettings} from './settings-calendar';

/** Settings (decision 2026-11-06): profile, appearance and colour, language, notifications,
 * calendar, backup for admins, sign out. A page on phones, a panel on PC; nothing moves while typing. */
export function SettingsScreen({remote, open, onOpenChange, lang, setLang, onExport}: {remote: TeamWorkspace; open: boolean; onOpenChange: (open: boolean) => void;
  lang: 'en' | 'he'; setLang: (lang: 'en' | 'he') => void; onExport?: () => void}) {
  const t = (en: string, he: string) => lang === 'he' ? he : en;
  const {preference, setPreference} = useTheme();
  const [name, setName] = useState(open ? remote.me?.name ?? '' : ''), [error, setError] = useState(''), [saved, setSaved] = useState(false);
  const [wasOpen, setWasOpen] = useState(open), [leaving, setLeaving] = useState(false), [colorBusy, setColorBusy] = useState(false);
  // Capture the latest saved name on opening, without overwriting an in-progress edit.
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {setName(remote.me?.name ?? ''); setError(''); setSaved(false);}
  }
  const me = remote.me, unchanged = name.trim() === (me?.name ?? '').trim();
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
  // Colours in use by other active members are shown taken; the member's own stays selectable.
  const taken = new Map((remote.snapshot?.members ?? []).filter(m => m.id !== me?.id && m.status === 'approved' && m.active).map(m => [memberColor(m.color).hex, m.name]));
  const current = memberColor(me?.color).hex;
  async function pickColor(hex: string) {
    if (colorBusy || remote.readOnly || hex === current) return;
    setColorBusy(true);
    try {await remote.setColor(hex);} catch (e) {toast.error(userMessage((e as Error).message, t));}
    finally {setColorBusy(false);}
  }
  return <Sheet open={open} onOpenChange={next => {if (!leaving) onOpenChange(next);}} lang={lang} kind="page" title={t('Settings', 'הגדרות')} className="settings-sheet" closeDisabled={leaving}
    // Focus the sheet itself, not the name field: on a phone that would open the keyboard.
    onOpenAutoFocus={event => {event.preventDefault(); (event.currentTarget as HTMLElement | null)?.focus();}}
    onCloseAutoFocus={event => {event.preventDefault(); document.querySelector<HTMLButtonElement>('[data-settings-button]')?.focus();}}
    // Esc first closes an open reminder-time picker (settings-notifications.tsx), not the sheet.
    onEscapeKeyDown={event => {if (document.querySelector('.settings-sheet .time-wheels')) event.preventDefault();}}>
    <section className="settings-section settings-profile" aria-labelledby="settings-profile-title">
      <h3 id="settings-profile-title" className="sr-only">{t('Profile', 'פרופיל')}</h3>
      <Avatar name={name || me?.name || ''} color={me?.color} size={72} className="settings-avatar"/>
      <label className="settings-name">
        <span className="sr-only">{t('Display name', 'שם לתצוגה')}</span>
        <input disabled={remote.readOnly} maxLength={80} value={name} placeholder={t('Your name', 'השם שלך')} onChange={e => {setName(e.target.value); setSaved(false);}}
          onKeyDown={e => {if (e.key === 'Enter' && name.trim() && !unchanged && !remote.saving && !remote.readOnly) void rename();}}/>
      </label>
      <p className="muted small">{me?.email}</p>
      <div className="settings-actions" aria-live="polite">
        {!unchanged && <Button size="sm" disabled={remote.readOnly || remote.saving || !name.trim()} onClick={rename}>{t('Save name', 'שמירת השם')}</Button>}
        {saved && unchanged && <span className="settings-saved" role="status">{t('Saved', 'נשמר')}</span>}
      </div>
      {error && <p className="note-line" data-tone="danger" role="alert">{error}</p>}
    </section>

    <SectionTitle>{t('Appearance', 'מראה')}</SectionTitle>
    <Card inset>
      <ListRow title={t('Theme', 'ערכת נושא')} trail={<Segmented size="sm" label={t('Theme', 'ערכת נושא')} value={preference} onChange={setPreference}
        options={[{value: 'auto', label: t('Auto', 'אוטומטי'), icon: <SunMoon/>}, {value: 'light', label: t('Light', 'בהיר'), icon: <Sun/>}, {value: 'dark', label: t('Dark', 'כהה'), icon: <Moon/>}]}/>}/>
      <div className="row row-column">
        <span className="row-title">{t('My colour', 'הצבע שלי')}</span>
        <div className="color-grid" role="radiogroup" aria-label={t('My colour', 'הצבע שלי')} aria-busy={colorBusy}>
          {PALETTE.map(c => {
            const owner = taken.get(c.hex), selected = c.hex === current;
            return <button key={c.hex} type="button" role="radio" aria-checked={selected} disabled={remote.readOnly || colorBusy || (!!owner && !selected)}
              className={'swatch member-tint' + (selected ? ' selected' : '') + (owner ? ' taken' : '')} style={memberStyle(c.hex)}
              aria-label={owner ? `${c.name[lang]} · ${owner}` : c.name[lang]} title={owner ? `${c.name[lang]} · ${owner}` : c.name[lang]} onClick={() => pickColor(c.hex)}>
              {selected && <Check aria-hidden="true"/>}
            </button>;
          })}
        </div>
      </div>
    </Card>

    <SectionTitle>{t('Language', 'שפה')}</SectionTitle>
    <Card inset>
      <ListRow title={t('Language', 'שפה')} trail={<Segmented size="sm" label={t('Language', 'שפה')} value={lang} onChange={setLang}
        options={[{value: 'en', label: <span lang="en">English</span>}, {value: 'he', label: <span lang="he">עברית</span>}]}/>}/>
    </Card>

    <NotificationSettingsPanel remote={remote} lang={lang} open={open}/>
    <CalendarSettings remote={remote} lang={lang}/>

    {onExport && <>
      <SectionTitle>{t('Admin', 'ניהול')}</SectionTitle>
      <Card inset><ListRow lead={<span className="row-icon" data-tone="neutral"><Download/></span>} title={t('Export backup', 'ייצוא גיבוי')} subtitle={t('JSON of the team and schedules', 'קובץ JSON של הצוות והלוחות')} chevron onClick={onExport}/></Card>
    </>}

    <section className="settings-section settings-sign-out" aria-label={t('Sign out', 'יציאה')}>
      <Button variant="outline" className="w-full" disabled={leaving} onClick={signOut}><LogOut/>{leaving ? t('Signing out…', 'מתנתק…') : t('Sign out', 'יציאה')}</Button>
    </section>
  </Sheet>;
}
