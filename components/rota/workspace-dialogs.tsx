import { CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { addDays, monthNext, type State, type Duty } from '@/lib/rota/engine';
import type { WorkspaceDraft } from '@/hooks/use-workspace-draft';
import type { Language, Translate, FormatDate } from './workspace-types';
type DialogCopy = { lang: Language; t: Translate };

export function DraftSwapDialog({
  controller,
  state,
  duties,
  lang,
  t,
  fmt,
  nickname,
  personName,
}: DialogCopy & {
  controller: WorkspaceDraft['swap'];
  state: State;
  duties: Duty[];
  fmt: FormatDate;
  nickname: (id?: string) => string;
  personName: (id?: string) => string;
}) {
  const {
    selection: swap,
    setSelection: setSwap,
    override: swapOverride,
    setOverride: setSwapOverride,
    preview: swapPreview,
    reason: swapReason,
    confirm: confirmSwap,
  } = controller;
  return (
    <Dialog open={!!swap} onOpenChange={(v) => !v && setSwap(null)}>
      <DialogContent dir={lang === 'he' ? 'rtl' : 'ltr'}>
        <DialogHeader>
          <DialogTitle>{t('Swap duties', 'החלפת תורנויות')}</DialogTitle>
          <DialogDescription>
            {t(
              'Primary engineers swap. Emergency cover stays on its dates.',
              'המהנדסים הראשיים מתחלפים. כיסוי החירום נשאר בתאריכים שלו.',
            )}
          </DialogDescription>
        </DialogHeader>
        {swap && (
          <>
            <div className="swap-review">
              {[swap.from, swap.to].map((id, i) => {
                const b = duties.find((b) => b.id === id),
                  other = i === 0 ? swap.to : swap.from;
                return (
                  <div key={id}>
                    <strong>
                      {fmt(id)}
                      {b && b.end !== addDays(id, 1) ? ` – ${fmt(addDays(b.end, -1))}` : ''}
                    </strong>
                    <span>
                      {nickname(state.assignments[id]?.primary)} →{' '}
                      <b>{nickname(state.assignments[other]?.primary)}</b>
                    </span>
                    <small>
                      {b?.points} {t('points', 'נקודות')}
                    </small>
                  </div>
                );
              })}
            </div>
            {swapPreview && !swapPreview.ok && (
              <div className="warning-note">{swapReason(swapPreview.reason)}</div>
            )}
            {!!swapPreview?.conflicts?.length && (
              <div className="warning-note">
                <p>
                  {swapPreview.conflicts
                    .map(
                      (c) =>
                        `${personName(c.person)} · ${fmt(c.date)}${state.constraintNotes?.[c.person]?.[c.date] ? ' · ' + state.constraintNotes[c.person][c.date] : ''}`,
                    )
                    .join(' / ')}
                </p>
                <label className="check-label">
                  <Checkbox checked={swapOverride} onCheckedChange={(v) => setSwapOverride(!!v)} />
                  {t('Override these constraints as manager', 'חריגה מאילוצים בהחלטת מנהל')}
                </label>
              </div>
            )}
            <Button disabled={!swapPreview?.ok} onClick={confirmSwap}>
              {t('Confirm swap', 'אישור החלפה')}
            </Button>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
export function SpecialDutyDialog({
  form,
  month,
  lang,
  t,
  fmt,
}: DialogCopy & { form: WorkspaceDraft['special']; month: string; fmt: FormatDate }) {
  const {
    open: specialOpen,
    setOpen: setSpecialOpen,
    title: specialTitle,
    setTitle: setSpecialTitle,
    start: specialStart,
    setStart: setSpecialStart,
    end: specialEnd,
    setEnd: setSpecialEnd,
    extra,
    setExtra,
    add: addSpecial,
  } = form;
  return (
    <Dialog open={specialOpen} onOpenChange={setSpecialOpen}>
      <DialogContent dir={lang === 'he' ? 'rtl' : 'ltr'}>
        <DialogHeader>
          <DialogTitle>{t('A special duty block', 'מקטע תורנות מיוחד')}</DialogTitle>
          <DialogDescription>
            {t(
              'Each date is a separate duty. Choose the extra points per date.',
              'כל יום הוא תורנות נפרדת. בחרו נקודות נוספות לכל יום.',
            )}
          </DialogDescription>
        </DialogHeader>
        <label className="field-label">
          {t('Name', 'שם')}
          <input
            maxLength={60}
            value={specialTitle}
            onChange={(e) => setSpecialTitle(e.target.value)}
            placeholder={t('e.g. Holiday coverage', 'למשל: כיסוי חג')}
          />
        </label>
        <div className="form-pair">
          <label className="field-label">
            {t('First duty date', 'יום תורנות ראשון')}
            <input
              type="date"
              value={specialStart}
              min={month + '-01'}
              max={addDays(monthNext(month) + '-01', -1)}
              onChange={(e) => {
                setSpecialStart(e.target.value);
                if (specialEnd < e.target.value) setSpecialEnd(e.target.value);
              }}
            />
          </label>
          <label className="field-label">
            {t('Last duty date', 'יום תורנות אחרון')}
            <input
              type="date"
              min={specialStart}
              value={specialEnd}
              onChange={(e) => setSpecialEnd(e.target.value)}
            />
          </label>
        </div>
        <label className="field-label">
          {t('Extra points per day', 'נקודות נוספות לכל יום')}
          <input
            type="number"
            min="0"
            max="20"
            step="0.5"
            value={extra}
            onChange={(e) => setExtra(e.target.value)}
          />
        </label>
        <div className="special-summary">
          <strong>
            {1 + Number(extra) || 1} {t('points per weekday', 'נקודות לכל יום חול')}
          </strong>
          <span>
            {t(
              'Weekday: 1 + extra. Friday / Saturday: ½ + extra each.',
              'יום חול: 1 + תוספת. שישי / שבת: ½ + תוספת לכל יום.',
            )}
          </span>
          <span>
            {specialStart &&
              specialEnd &&
              `${fmt(specialStart)} 09:00 → ${fmt(addDays(specialEnd, 1))} 09:00`}
          </span>
        </div>
        <p className="muted-copy">
          {t(
            'Replaces duties in these dates, including weekends. Affected assignments are cleared for review.',
            'מחליף את התורנויות בתאריכים אלה, כולל סופי שבוע. השיבוצים המושפעים ינוקו לבדיקה מחדש.',
          )}
        </p>
        <Button onClick={addSpecial}>{t('Add special block', 'הוספת מקטע מיוחד')}</Button>
      </DialogContent>
    </Dialog>
  );
}
export function MonthSettingsDialog({
  settings,
  setSettings,
  monthLabel,
  monthDetails,
  lang,
  t,
  onDeadline,
}: DialogCopy & {
  settings: boolean;
  setSettings: (open: boolean) => void;
  monthLabel: string;
  monthDetails: State['months'][string];
  onDeadline: (deadline: string) => void;
}) {
  return (
    <Dialog open={settings} onOpenChange={setSettings}>
      <DialogContent dir={lang === 'he' ? 'rtl' : 'ltr'}>
        <DialogHeader>
          <DialogTitle>
            {t('Change month deadline', 'שינוי מועד אחרון לחודש')} · {monthLabel}
          </DialogTitle>
          <DialogDescription>
            {t(
              'Choose when the team should finish entering next month’s constraints.',
              'בחרו עד מתי הצוות יזין את האילוצים לחודש הבא.',
            )}
          </DialogDescription>
        </DialogHeader>
        <label className="field-label">
          {t('Constraints deadline', 'מועד אחרון לאילוצים')}
          <input
            type="date"
            value={monthDetails.deadline}
            onChange={(e) => {
              if (e.target.value) onDeadline(e.target.value);
            }}
          />
        </label>
        <p className="muted-copy">
          {t(
            'Engineers can enter constraints until this date, in Israel time.',
            'מהנדסים יוכלו להזין אילוצים עד לתאריך זה, לפי שעון ישראל.',
          )}
        </p>
        <Button onClick={() => setSettings(false)}>{t('Done', 'סיום')}</Button>
      </DialogContent>
    </Dialog>
  );
}
export function PublishDialog({
  publishOpen,
  setPublishOpen,
  monthLabel,
  assigned,
  saving,
  lang,
  t,
  onPublish,
}: DialogCopy & {
  publishOpen: boolean;
  setPublishOpen: (open: boolean) => void;
  monthLabel: string;
  assigned: number;
  saving: boolean;
  onPublish: () => Promise<void>;
}) {
  return (
    <Dialog open={publishOpen} onOpenChange={setPublishOpen}>
      <DialogContent dir={lang === 'he' ? 'rtl' : 'ltr'}>
        <DialogHeader>
          <DialogTitle>{t('Ready to publish?', 'מוכנים לפרסום?')}</DialogTitle>
          <DialogDescription>
            {monthLabel} · {assigned} {t('duties covered', 'תורנויות משובצות')}
          </DialogDescription>
        </DialogHeader>
        <div className="publish-summary">
          <CheckCircle2 size={30} />
          <p>
            {t(
              'The schedule will be visible to approved team members.',
              'הלוח יהיה זמין לחברי צוות שאושרו.',
            )}
          </p>
        </div>
        <p className="muted-copy">
          {t(
            'No notifications are sent yet. You can reopen and adjust this schedule any time.',
            'עדיין לא נשלחות התראות. ניתן לפתוח ולערוך מחדש בכל עת.',
          )}
        </p>
        <Button disabled={saving} onClick={onPublish}>
          {t('Publish schedule', 'פרסום הלוח')}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
export function WorkspaceHelpDialog({
  help,
  setHelp,
  lang,
  t,
}: DialogCopy & { help: boolean; setHelp: (open: boolean) => void }) {
  return (
    <Dialog open={help} onOpenChange={setHelp}>
      <DialogContent dir={lang === 'he' ? 'rtl' : 'ltr'}>
        <DialogHeader>
          <DialogTitle>{t('Your first working rota', 'לוח התורנויות הראשון שלך')}</DialogTitle>
          <DialogDescription>
            {t('Shared scheduling for your team', 'ניהול תורנויות משותף לצוות')}
          </DialogDescription>
        </DialogHeader>
        <ol className="guide-list">
          <li>
            {t(
              'Set availability and reorder the team from most senior to newest.',
              'הזינו אילוצים וסדרו את הצוות מהוותיק ביותר לחדש ביותר.',
            )}
          </li>
          <li>
            {t(
              'Add special blocks with dates and extra points, then generate the month.',
              'הוסיפו מקטעים מיוחדים עם תאריכים ונקודות, ואז צרו שיבוץ לחודש.',
            )}
          </li>
          <li>
            {t(
              'Tap to edit a duty or one weekend day. Hold and drag between duties to swap.',
              'לחצו לעריכת תורנות או יום אחד בסוף השבוע. לחיצה ארוכה וגרירה מחליפה תורנויות.',
            )}
          </li>
          <li>
            {t(
              'Each month starts fresh. Newer engineers are preferred for extra duties; all-month totals remain visible.',
              'כל חודש מתחיל מחדש. מהנדסים חדשים יקבלו עדיפות לתורנויות נוספות; סיכומי כל החודשים מוצגים בצוות.',
            )}
          </li>
        </ol>
        <div className="inline-note">
          {t(
            'Your constraints are visible to you and the manager. Only approved members can see published schedules. Push notifications and calendar subscriptions are not connected yet. Swap requests require admin approval.',
            'האילוצים גלויים רק לך ולמנהל. רק חברים שאושרו יכולים לראות לוחות שפורסמו. התראות ומנויי יומן עדיין לא מחוברים. בקשות החלפה דורשות אישור מנהל.',
          )}
        </div>
        <Button onClick={() => setHelp(false)}>{t('Let’s plan', 'מתחילים לתכנן')}</Button>
      </DialogContent>
    </Dialog>
  );
}
