'use client';
import {useState} from 'react';
import {Check, PenLine} from 'lucide-react';
import {Sheet} from '@/components/ui/sheet';
import {Avatar} from '@/components/ui/avatar';
import {Button} from '@/components/ui/button';
import {Card} from '@/components/ui/card';
import {Chip} from '@/components/ui/chip';
import {Segmented} from '@/components/ui/segmented';
import {Switch} from '@/components/ui/switch';
import {NetBreakdown} from '@/components/rota/net-balance';
import type {Role} from '@/lib/supabase/snapshot';
import type {Balance} from '@/lib/supabase/balance';
import type {Engineer} from '@/lib/rota/engine';
import {PALETTE, memberColor, memberStyle} from '@/lib/theme/palette';
import type {Language, Translate} from './workspace-types';

export type MemberSheetProps = {
  member: Engineer | null; open: boolean; onClose: () => void; lang: Language; t: Translate; selfId: string; admin: boolean; saving: boolean;
  roles: Role[]; temporary: boolean; noWeekends: boolean; monthPoints: number; allPoints: number; balance: Balance | null; name: (id: string) => string; team: Engineer[];
  onRole: (role: string) => void; onNoWeekends: (value: boolean) => void; onActive: (value: boolean) => void; onColor: (hex: string) => void; onRename?: () => void;
};

/** One member (decision 2026-11-06): their points and balance for everyone; role, No weekends,
 * Active and a colour override for admins. A bottom sheet on phones, a panel on PC. */
export function MemberSheet({member, open, onClose, lang, t, selfId, admin, saving, roles, temporary, noWeekends, monthPoints, allPoints, balance, name, team, onRole, onNoWeekends, onActive, onColor, onRename}: MemberSheetProps) {
  const [colorBusy, setColorBusy] = useState(false);
  const p = member;
  const roleLabel = (code?: string) => {const r = roles.find(r => r.code === code); return r ? (lang === 'he' ? (r.can_manage ? 'מנהל' : 'מהנדס') : r.label) : t('Engineer', 'מהנדס');};
  const taken = new Map(team.filter(m => m.id !== p?.id && m.active).map(m => [memberColor(m.color).hex, m.name]));
  const current = memberColor(p?.color).hex;
  return <Sheet open={open && !!p} onOpenChange={next => {if (!next) onClose();}} lang={lang} title={p?.name ?? ''} description={p ? [temporary ? t('Temporary', 'זמני') : roleLabel(p.role), p.id === selfId ? t('you', 'אני') : null, !p.active ? t('Inactive', 'לא פעיל') : null].filter(Boolean).join(' · ') : ''}
    className="member-sheet" busy={saving}
    tools={admin && temporary && onRename ? <Button variant="ghost" size="icon-sm" aria-label={t('Edit name', 'עריכת שם')} onClick={onRename}><PenLine/></Button> : undefined}>
    {p && <>
      <div className="member-hero">
        <Avatar name={p.name} color={p.color} size={72}/>
        <div className="member-stats">
          <div><strong>{monthPoints}</strong><span>{t('this month', 'החודש')}</span></div>
          <div><strong>{allPoints}</strong><span>{t('all months', 'כל החודשים')}</span></div>
        </div>
      </div>
      {balance && <Card><NetBreakdown memberId={p.id} balance={balance} name={name} lang={lang}/></Card>}
      {admin && <Card inset>
        <div className="row"><span className="row-body"><span className="row-title">{t('Role', 'תפקיד')}</span></span><span className="row-trail">
          {temporary ? <Chip tone="neutral">{t('Temporary', 'זמני')}</Chip>
            : <Segmented size="sm" label={`${t('Role', 'תפקיד')} ${p.name}`} value={p.role ?? 'engineer'} onChange={onRole} disabled={saving} options={roles.map(r => ({value: r.code, label: roleLabel(r.code)}))}/>}
        </span></div>
        <div className="row"><span className="row-body"><label className="row-title" htmlFor="member-no-weekends">{t('No weekends', 'ללא סופי שבוע')}</label></span><span className="row-trail">
          <Switch id="member-no-weekends" disabled={saving} checked={noWeekends} aria-label={`${t('No weekends', 'ללא סופי שבוע')} ${p.name}`} onCheckedChange={v => onNoWeekends(v === true)}/></span></div>
        <div className="row"><span className="row-body"><label className="row-title" htmlFor="member-active">{t('Active', 'פעיל')}</label>{p.id === selfId && <span className="row-subtitle">{t('You can’t deactivate yourself', 'אי אפשר להשבית את עצמך')}</span>}</span><span className="row-trail">
          <Switch id="member-active" disabled={saving || p.id === selfId} checked={p.active} aria-label={`${t('Active', 'פעיל')} ${p.name}`} onCheckedChange={v => onActive(v === true)}/></span></div>
        <div className="row row-column">
          <span className="row-title">{t('Colour', 'צבע')}</span>
          <div className="color-grid" role="radiogroup" aria-label={`${t('Colour', 'צבע')} ${p.name}`} aria-busy={colorBusy}>
            {PALETTE.map(c => {
              const owner = taken.get(c.hex), selected = c.hex === current;
              return <button key={c.hex} type="button" role="radio" aria-checked={selected} disabled={saving || colorBusy || (!!owner && !selected)}
                className={'swatch member-tint' + (selected ? ' selected' : '') + (owner ? ' taken' : '')} style={memberStyle(c.hex)}
                aria-label={owner ? `${c.name[lang]} · ${owner}` : c.name[lang]} title={owner ? `${c.name[lang]} · ${owner}` : c.name[lang]}
                onClick={async () => {if (selected) return; setColorBusy(true); try {await onColor(c.hex);} finally {setColorBusy(false);}}}>
                {selected && <Check aria-hidden="true"/>}
              </button>;
            })}
          </div>
        </div>
      </Card>}
      {!admin && noWeekends && <Chip tone="neutral">{t('No weekends', 'ללא סופי שבוע')}</Chip>}
    </>}
  </Sheet>;
}
