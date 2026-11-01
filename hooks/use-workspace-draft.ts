'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { TeamWorkspace } from '@/hooks/use-team-workspace';
import type { Translate, UpdateDraft } from '@/components/rota/workspace-types';
import { prepareWorkspaceUpdate, clearableAssignments, clearBoard, restoreCleared } from '@/lib/rota/workspace-data';
import {userMessage} from '@/lib/messages';
import {
  addDays,
  dates,
  allKnownBlocks,
  overlap,
  ownerMonth,
  dayOf,
  removeSpecialDates,
  swapDraft,
  type State,
  type Duty,
} from '@/lib/rota/engine';

// Owns draft mutations and their editor state. Remote persistence stays in TeamWorkspace.
export function useWorkspaceDraft({
  remote,
  state,
  month,
  monthDetails,
  t,
}: {
  remote: TeamWorkspace;
  state: State;
  month: string;
  monthDetails: State['months'][string];
  t: Translate;
}) {
  const isManager = remote.isAdmin;
  const [selected, setSelected] = useState<Duty | null>(null);
  const [specialOpen, setSpecialOpen] = useState(false);
  const [specialTitle, setSpecialTitle] = useState(''),
    [specialStart, setSpecialStart] = useState(month + '-01'),
    [specialEnd, setSpecialEnd] = useState(month + '-02'),
    [extra, setExtra] = useState('1');
  const [swap, setSwap] = useState<{ from: string; to: string } | null>(null),
    [swapOverride, setSwapOverride] = useState(false);
  const [swapSaving, setSwapSaving] = useState(false);
  function selectSwap(selection: typeof swap) {
    setSwapOverride(false);
    setSwap(selection);
  }
  async function update(fn: (s: State) => State, draft = true, notifyError = true, reviewedLocks?: string[]) {
    if (!isManager) return false;
    const s = state,
      n = prepareWorkspaceUpdate(s, fn(s), month, monthDetails, draft);
    try {
      const published = Object.keys(n.months).find(
        (m) => n.months[m].status === 'published' && s.months[m]?.status !== 'published',
      );
      await remote.save(n, published, month, reviewedLocks);
      return true;
    } catch (e) {
      if (!notifyError) throw e;
      toast.error(userMessage((e as Error).message, t));
      return false;
    }
  }
  // Undo runs after later renders, so it saves against the newest state, never the cleared one.
  const latest = useRef(update);
  useEffect(() => {latest.current = update;});
  // Undo belongs to the cleared draft: leaving the month or its draft drops the offer.
  const clearToast = useRef<string | number | undefined>(undefined);
  useEffect(() => () => {if (clearToast.current !== undefined) toast.dismiss(clearToast.current);}, [month, monthDetails.status]);
  const [clearOpen, setClearOpen] = useState(false);
  const clearable = useMemo(() => isManager && monthDetails.status === 'draft' ? Object.keys(clearableAssignments(state, month)).length : 0,
    [isManager, monthDetails.status, state, month]);
  async function confirmClear() {
    const cleared = clearableAssignments(state, month), count = Object.keys(cleared).length, generated = monthDetails.generated;
    if (!count || !(await update((s) => clearBoard(s, month)))) return;
    setClearOpen(false);
    setSelected(null);
    selectSwap(null);
    clearToast.current = toast.success(count === 1 ? t('Cleared 1 duty.', 'תורנות אחת נוקתה.') : t(`Cleared ${count} duties.`, `${count} תורנויות נוקו.`), {
      duration: 10000,
      action: {
        label: t('Undo', 'שחזור'),
        onClick: async () => {
          if (await latest.current((s) => restoreCleared(s, month, cleared, generated))) toast.success(t('Duties restored.', 'התורנויות שוחזרו.'));
        },
      },
    });
  }
  function openDuty(b: Duty) {
    if (isManager && monthDetails.status === 'draft' && ownerMonth(b) === month) setSelected(b);
  }
  async function addSpecial() {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(specialStart) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(specialEnd) ||
      specialEnd < specialStart ||
      (Date.parse(specialEnd) - Date.parse(specialStart)) / 86400000 >= 14
    ) {
      toast.error(t('Choose a valid block of 1–14 days.', 'יש לבחור מקטע תקין של 1–14 ימים.'));
      return;
    }
    const end = addDays(specialEnd, 1),
      x = {
        id: crypto.randomUUID(),
        title: specialTitle.trim() || t('Special duty', 'תורנות מיוחדת'),
        start: specialStart,
        end,
        extra: Number(extra),
      };
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(x.start) ||
      specialEnd < x.start ||
      x.start.slice(0, 7) !== month ||
      dates(x.start, end).length > 14 ||
      !Number.isFinite(x.extra) ||
      x.extra < 0 ||
      x.extra > 20 || !Number.isInteger(x.extra * 2)
    ) {
      toast.error(
        t(
          'Choose up to 14 days starting this month, and 0–20 extra points.',
          'יש לבחור עד 14 ימים שמתחילים בחודש זה ו־0–20 נקודות נוספות.',
        ),
      );
      return;
    }
    if (dates(x.start, x.end).some(d => (dayOf(d) === 6 ? addDays(d, -1) : d).slice(0, 7) !== month)) {
      toast.error(t('Special blocks must stay within this month’s owned duties.', 'מקטעים מיוחדים חייבים להישאר בתורנויות השייכות לחודש זה.'));
      return;
    }
    if (state.specials.some((s) => overlap(s, x))) {
      toast.error(
        t(
          'This overlaps another special block. Remove it first.',
          'קיימת חפיפה עם מקטע מיוחד אחר.',
        ),
      );
      return;
    }
    const touched = allKnownBlocks(state).filter((b) => overlap(b, x));
    if (touched.some(b => state.assignments[b.id]?.secondary)) {
      toast.error(t('Review emergency cover on these dates before changing duty structure.', 'יש לבדוק את כיסוי החירום בתאריכים אלה לפני שינוי המבנה.'));
      return;
    }
    if (touched.some((b) => ownerMonth(b) !== month && state.assignments[b.id]?.primary)) {
      toast.error(
        t(
          'This overlaps an assigned duty from another month. Edit that month first.',
          'יש חפיפה לשיבוץ מחודש אחר. יש לערוך אותו קודם.',
        ),
      );
      return;
    }
    const saved = await update((s) => {
      const assignments = { ...s.assignments };
      touched.forEach((b) => delete assignments[b.id]);
      return { ...s, assignments, specials: [...s.specials, x] };
    });
    if (!saved) return;
    setSpecialOpen(false);
    toast.success(
      t(
        'Special block added. Generate to fill its assignment.',
        'המקטע נוסף. ניתן ליצור שיבוץ חדש.',
      ),
    );
  }
  function startSwap(from: string, to: string) {
    if (!isManager || swapSaving || from === to) return;
    selectSwap({ from, to });
  }
  const swapPreview = swap ? swapDraft(state, month, swap.from, swap.to, swapOverride) : null;
  const swapReason = (reason: string) =>
    ({
      published: t('Reopen the draft first.', 'יש לפתוח טיוטה תחילה.'),
      'same-duty': t('Choose another duty.', 'יש לבחור תורנות אחרת.'),
      'other-month': t('Swap within the starting month.', 'ניתן להחליף בתוך חודש ההתחלה.'),
      unassigned: t('Both duties need an engineer.', 'יש לשבץ מהנדס בשתי התורנויות.'),
      locked: t('Unlock these duties before swapping.', 'יש לבטל נעילה לפני החלפה.'),
      'same-person': t(
        'These duties already have the same engineer.',
        'שתי התורנויות משובצות לאותו מהנדס.',
      ),
      duplicate: t(
        'A primary engineer cannot also be the emergency cover.',
        'אותו מהנדס לא יכול למלא את שני התפקידים.',
      ),
      inactive: t('Choose active engineers.', 'יש לבחור מהנדסים פעילים.'),
      'weekend-limit': t(
        'This swap adds another weekend. Manager approval is required.',
        'ההחלפה מוסיפה סוף שבוע נוסף. נדרש אישור מנהל.',
      ),
      availability: t('This swap conflicts with availability.', 'ההחלפה מתנגשת עם אילוצים.'),
    })[reason] ?? reason;
  async function confirmSwap() {
    if (!isManager || !swap || swapSaving) return;
    const result = swapDraft(state, month, swap.from, swap.to, swapOverride);
    if (!result.ok) {
      toast.error(swapReason(result.reason));
      return;
    }
    setSwapSaving(true);
    try {
      if (!(await update((s) => ({ ...s, assignments: result.assignments })))) return;
      selectSwap(null);
      toast.success(t('Duties swapped.', 'התורנויות הוחלפו.'));
    } finally {
      setSwapSaving(false);
    }
  }
  const saveDuty = async (fn: Parameters<UpdateDraft>[0], reviewedLocks?: string[]): Promise<void> => {
    if (!(await update(fn, true, true, reviewedLocks))) return;
    setSelected(null);
    toast.success(t('Assignment saved to draft.', 'השיבוץ נשמר בטיוטה.'));
  };
  const removeSpecial = async () => {
    const b = selected;
    if (!b) return;
    // Every date of this duty loses its extra; a combined weekend stays combined and a hand
    // split stays split. The points change, so a locked duty is reviewed explicitly.
    const reviewed = b.weekendId ? [b.weekendId, addDays(b.weekendId, 1)] : [b.id];
    if (!(await update((s) => removeSpecialDates(s, b), true, true, reviewed))) return;
    setSelected(null);
  };
  function resetSpecialDates(month: string) {
    setSpecialStart(month + '-01');
    setSpecialEnd(month + '-02');
  }
  return {
    update,
    resetSpecialDates,
    editor: { selected, setSelected, openDuty, save: saveDuty, removeSpecial },
    clear: { open: clearOpen, setOpen: setClearOpen, count: clearable, confirm: confirmClear },
    special: {
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
    },
    swap: {
      selection: swap,
      setSelection: selectSwap,
      saving: swapSaving,
      override: swapOverride,
      setOverride: setSwapOverride,
      preview: swapPreview,
      reason: swapReason,
      start: startSwap,
      confirm: confirmSwap,
    },
  };
}
export type WorkspaceDraft = ReturnType<typeof useWorkspaceDraft>;
