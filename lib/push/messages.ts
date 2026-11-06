// Notification text in the member's own language (decision 2026-11-06). The database
// records only the kind and dates; the sender writes the words here, so they never
// carry constraint notes, swap explanations or anything else private.
export type PushLanguage = 'en' | 'he';
export const PUSH_KINDS = ['deadline_3', 'deadline_1', 'published', 'republished', 'edit', 'swap_new', 'swap_accepted', 'swap_awaiting_admin',
  'swap_declined', 'swap_rejected', 'swap_approved', 'remind_evening', 'remind_morning', 'member_waiting'] as const;
export type PushKind = typeof PUSH_KINDS[number];
export type PushParams = {month?: string; deadline?: string; version?: number; day?: string; count?: number; fromDay?: string; toDay?: string;
  endDay?: string; role?: 'primary' | 'secondary'; name?: string};
export type PushText = {title: string; body: string};

const DAY = /^\d{4}-\d{2}-\d{2}$/, MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const locale = (lang: PushLanguage) => lang === 'he' ? 'he-IL' : 'en-GB';
/** A date-only key in Israel, e.g. "Thu 12 Nov" / "יום ה׳, 12 בנוב׳". */
export function pushDate(day: string | undefined, lang: PushLanguage) {
  if (!day || !DAY.test(day)) return '';
  return new Date(day + 'T12:00:00Z').toLocaleDateString(locale(lang), {weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Jerusalem'});
}
export function pushMonth(month: string | undefined, lang: PushLanguage) {
  if (!month || !MONTH.test(month)) return '';
  return new Date(month + '-01T12:00:00Z').toLocaleDateString(locale(lang), {month: 'long', year: 'numeric', timeZone: 'UTC'});
}
const clean = (value: unknown, max: number) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';

export function pushText(kind: PushKind, params: PushParams, lang: PushLanguage): PushText {
  const t = (en: string, he: string) => lang === 'he' ? he : en;
  const month = pushMonth(params.month, lang), deadline = pushDate(params.deadline, lang);
  const day = pushDate(params.day, lang), from = pushDate(params.fromDay, lang), to = pushDate(params.toDay, lang);
  const swap = from && to ? `${from} ↔ ${to}` : '';
  const cover = params.role === 'secondary';
  switch (kind) {
    case 'deadline_3': return {title: t('Constraints close in 3 days', 'הגשת האילוצים נסגרת בעוד 3 ימים'),
      body: t(`Enter your ${month} constraints by ${deadline}.`, `יש להזין את האילוצים ל${month} עד ${deadline}.`)};
    case 'deadline_1': return {title: t('Constraints close tomorrow', 'הגשת האילוצים נסגרת מחר'),
      body: t(`You haven’t entered constraints for ${month} yet. The deadline is ${deadline}.`, `עדיין לא הזנת אילוצים ל${month}. המועד האחרון הוא ${deadline}.`)};
    case 'published': return {title: t(`${month} is published`, `${month} פורסם`), body: t('See your duties in the schedule.', 'אפשר לראות את התורנויות שלך בלוח.')};
    case 'republished': return {title: t(`${month} was updated`, `${month} עודכן`), body: t('A new version of the schedule is published. Check your duties.', 'גרסה חדשה של הלוח פורסמה. כדאי לבדוק את התורנויות שלך.')};
    case 'edit': {
      const more = (params.count ?? 1) > 1;
      return {title: t('Your duty was changed', 'התורנות שלך שונתה'),
        body: more ? t(`An admin changed your duties from ${day} (${params.count} dates).`, `מנהל שינה את התורנויות שלך החל מ־${day} (${params.count} תאריכים).`)
          : t(`An admin changed your duty on ${day}.`, `מנהל שינה את התורנות שלך ב־${day}.`)};
    }
    case 'swap_new': return {title: t('New swap request', 'בקשת החלפה חדשה'), body: t(`Swap ${swap}. Open it to answer.`, `החלפה ${swap}. יש לפתוח כדי להשיב.`)};
    case 'swap_accepted': return {title: t('Swap accepted', 'ההחלפה התקבלה'), body: t(`Swap ${swap} was accepted.`, `ההחלפה ${swap} התקבלה.`)};
    case 'swap_awaiting_admin': return {title: t('Swap waiting for approval', 'החלפה ממתינה לאישור'), body: t(`Both members accepted swap ${swap}.`, `שני חברי הצוות הסכימו להחלפה ${swap}.`)};
    case 'swap_declined': return {title: t('Swap declined', 'ההחלפה נדחתה'), body: t(`Swap ${swap} was declined.`, `ההחלפה ${swap} נדחתה.`)};
    case 'swap_rejected': return {title: t('Swap not approved', 'ההחלפה לא אושרה'), body: t(`An admin didn’t approve swap ${swap}.`, `מנהל לא אישר את ההחלפה ${swap}.`)};
    case 'swap_approved': return {title: t('Swap approved', 'ההחלפה אושרה'), body: t(`Swap ${swap} is approved and in the schedule.`, `ההחלפה ${swap} אושרה ונכנסה ללוח.`)};
    case 'remind_evening': return {title: cover ? t('Emergency cover tomorrow', 'כיסוי חירום מחר') : t('Duty tomorrow', 'תורנות מחר'),
      body: cover ? t(`You’re emergency cover on ${day}.`, `יש לך כיסוי חירום ב־${day}.`) : t(`You’re on duty on ${day}.`, `יש לך תורנות ב־${day}.`)};
    case 'remind_morning': return {title: cover ? t('Emergency cover today', 'כיסוי חירום היום') : t('Duty today', 'תורנות היום'),
      body: cover ? t(`You’re emergency cover today, ${day}.`, `יש לך כיסוי חירום היום, ${day}.`) : t(`You’re on duty today, ${day}.`, `יש לך תורנות היום, ${day}.`)};
    case 'member_waiting': {
      const name = clean(params.name, 80);
      return {title: t('New member waiting', 'חבר צוות חדש ממתין'),
        body: name ? t(`${name} is waiting for your approval.`, `${name} ממתין/ה לאישור שלך.`) : t('Someone is waiting for your approval.', 'מישהו ממתין לאישור שלך.')};
    }
  }
}
