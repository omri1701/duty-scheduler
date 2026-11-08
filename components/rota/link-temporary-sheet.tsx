'use client';
import {useState} from 'react';
import {toast} from 'sonner';
import {Link2} from 'lucide-react';
import {Sheet} from '@/components/ui/sheet';
import {Button} from '@/components/ui/button';
import {Card, SectionTitle} from '@/components/ui/card';
import {ListRow} from '@/components/ui/list-row';
import {Avatar} from '@/components/ui/avatar';
import type {TeamWorkspace} from '@/hooks/use-team-workspace';
import type {Member} from '@/lib/supabase/snapshot';
import {userMessage} from '@/lib/messages';

/** Link a pending sign-up to a temporary member (decision 2026-11-07): pick the member (active
 * first, inactive in their own group), then confirm, because the merge can't be undone. A sheet
 * on phones, a side panel on PC; the confirmation is a small dialog above it. */
export function LinkTemporarySheet({pending: open, remote, lang, onClose}: {pending: Member | null; remote: TeamWorkspace; lang: 'en' | 'he'; onClose: () => void}) {
  const t = (en: string, he: string) => lang === 'he' ? he : en;
  const [target, setTarget] = useState<Member | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  // The last sign-up stays drawn while the sheet slides away after a link removes it.
  const [last, setLast] = useState(open);
  if (open && open !== last) setLast(open);
  const pending = open ?? last;
  const raw = remote.snapshot, temporary = raw?.members.filter(m => m.is_temporary) ?? [];
  const current = new Set(raw?.months.map(m => m.current_publication_id).filter(Boolean));
  const duties = (id: string) => raw?.assignments.filter(a => a.publication_id && current.has(a.publication_id) && a.primary_id === id).length ?? 0;
  const dutyLine = (n: number) => n === 0 ? t('No duties yet', 'אין כוננויות עדיין') : n === 1 ? t('1 duty', 'כוננות אחת') : t(`${n} duties`, `${n} כוננויות`);
  const close = () => {if (!busy) {setTarget(null); setError(''); onClose();}};
  async function link() {
    if (!open || !target || busy || remote.readOnly) return;
    setBusy(true); setError('');
    try {
      await remote.linkTemporaryMember(open.id, target.id);
      toast.success(t(`Linked to ${target.name}`, `ההרשמה קושרה ל${target.name}`));
      setTarget(null); onClose();
    } catch (e) {setError(userMessage((e as Error).message, t));}
    finally {setBusy(false);}
  }
  const group = (members: Member[], title: string) => <>
    <SectionTitle>{title}</SectionTitle>
    <Card inset role="group" aria-label={title}>
      {members.map(m => <ListRow key={m.id} className="link-choice" disabled={busy || remote.readOnly} chevron
        lead={<Avatar name={m.name} color={m.color} size={36}/>} title={m.name} subtitle={dutyLine(duties(m.id))}
        aria-label={`${m.name} · ${dutyLine(duties(m.id))}`} onClick={() => {setError(''); setTarget(m);}}/>)}
    </Card>
  </>;
  const active = temporary.filter(m => m.active), inactive = temporary.filter(m => !m.active);
  return <>
    {/* The two sheets are siblings, so Escape can reach the picker while the confirmation is up;
        it then closes only the confirmation, whichever layer receives the key. */}
    <Sheet open={!!open} onOpenChange={next => {if (!next) close();}} lang={lang} className="link-sheet" closeDisabled={busy} busy={busy}
      onEscapeKeyDown={event => {if (target) {event.preventDefault(); if (!busy) {setTarget(null); setError('');}}}}
      title={t('Link to a temporary member', 'קישור לחבר צוות זמני')}
      description={pending ? t(`${pending.name}’s sign-up merges with the member you choose. Their duties and history stay, and they can sign in.`, `ההרשמה של ${pending.name} תתאחד עם חבר הצוות שתבחרו. הכוננויות וההיסטוריה נשמרות, ומעכשיו אפשר להתחבר.`) : undefined}>
      {pending && <div className="link-signup">
        <Avatar name={pending.name} size={40}/>
        <span className="row-body"><span className="row-title">{pending.name}</span><span className="row-subtitle" dir="ltr">{pending.email}</span></span>
      </div>}
      {active.length > 0 && group(active, t('Temporary members', 'חברי צוות זמניים'))}
      {inactive.length > 0 && group(inactive, t('Inactive', 'לא פעילים'))}
    </Sheet>
    <Sheet open={!!open && !!target} onOpenChange={next => {if (!next && !busy) {setTarget(null); setError('');}}} lang={lang} kind="alert" role="alertdialog" closeDisabled={busy} busy={busy} className="link-confirm"
      title={pending && target ? t(`Link ${pending.name}'s sign-up to temporary member ${target.name}?`, `לקשר את ההרשמה של ${pending.name} לחבר הצוות הזמני ${target.name}?`) : ''}
      description={t('Their duties, points, nets and constraints become theirs. This can’t be undone.', `הכוננויות, הנקודות, המאזנים והאילוצים של ${target?.name ?? ''} יעברו ל${pending?.name ?? ''}. אי אפשר לבטל את זה.`)}
      footer={<div className="sheet-actions">
        <Button variant="secondary" disabled={busy} onClick={() => {setTarget(null); setError('');}}>{t('Cancel', 'ביטול')}</Button>
        <Button disabled={busy || remote.readOnly} onClick={() => void link()}>{busy ? t('Linking…', 'מקשר…') : t('Link', 'קישור')}</Button>
      </div>}>
      {pending && target && <div className="link-pair" aria-hidden="true">
        <Avatar name={pending.name} size={48}/>
        <span className="link-pair-icon"><Link2/></span>
        <Avatar name={target.name} color={target.color} size={48}/>
      </div>}
      {/* The email tells two people with the same name apart before an irreversible link. */}
      {pending && target && <p className="link-email"><span dir="ltr">{pending.email}</span></p>}
      {error && <p className="note-line" data-tone="danger" role="alert">{error}</p>}
    </Sheet>
  </>;
}
