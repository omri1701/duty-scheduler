'use client';
import {useState} from 'react';
import {ArrowLeftRight, CalendarCheck, House} from 'lucide-react';
import {Sheet} from '@/components/ui/sheet';
import {Button} from '@/components/ui/button';
import {APP_NAME} from '@/lib/brand';
import type {Language, Translate} from '@/components/rota/workspace-types';

const KEY = 'duty-welcome-seen';
export function welcomeSeen() {try {return localStorage.getItem(KEY) === '1';} catch {return true;}}
function markSeen() {try {localStorage.setItem(KEY, '1');} catch {}}

/** Three cards on the first sign-in on a device (decision 2026-11-06). */
export function Welcome({open, onClose, lang, t}: {open: boolean; onClose: () => void; lang: Language; t: Translate}) {
  const [step, setStep] = useState(0);
  const cards = [
    {icon: <House/>, title: t(`Welcome to ${APP_NAME}`, `ברוכים הבאים ל־${APP_NAME}`), text: t('Home shows your next duty and what needs you.', 'הבית מציג את התורנות הבאה שלך ומה שמחכה לך.')},
    {icon: <ArrowLeftRight/>, title: t('Swap in a tap', 'החלפה בלחיצה'), text: t('Tap a duty in Schedule, or hold and drag it onto another.', 'לוחצים על תורנות בלוח, או מחזיקים וגוררים אל תורנות אחרת.')},
    {icon: <CalendarCheck/>, title: t('Say when you can’t', 'אומרים מתי אי אפשר'), text: t('Mark unavailable days before the deadline; the plan respects them.', 'מסמנים ימים לא זמינים לפני המועד האחרון; התוכנית מכבדת אותם.')},
  ];
  const last = step === cards.length - 1;
  const finish = () => {markSeen(); onClose();};
  const card = cards[step];
  return <Sheet open={open} onOpenChange={next => {if (!next) finish();}} lang={lang} kind="alert" title={card.title} className="welcome"
    footer={<div className="sheet-actions">
      {!last && <Button variant="ghost" onClick={finish}>{t('Skip', 'דילוג')}</Button>}
      <Button onClick={() => last ? finish() : setStep(step + 1)}>{last ? t('Let’s go', 'יאללה') : t('Next', 'הבא')}</Button>
    </div>}>
    <div className="welcome-card" key={step}>
      <span className="welcome-icon">{card.icon}</span>
      <p>{card.text}</p>
      <div className="hero-dots" aria-hidden="true">{cards.map((_, i) => <span key={i} className={i === step ? 'on' : ''}/>)}</div>
    </div>
  </Sheet>;
}
