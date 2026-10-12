'use client';
import { useState } from 'react';
import { toast } from 'sonner';
import type { TeamWorkspace } from '@/hooks/use-team-workspace';
import type { Translate, UpdateDraft } from '@/components/rota/workspace-types';
import { prepareWorkspaceUpdate } from '@/lib/rota/workspace-data';
import {
  addDays,
  dates,
  monthNext,
  generate,
  allKnownBlocks,
  overlap,
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
    [extra, setExtra] = useState('1'),
    [busy, setBusy] = useState(false);
  const [swap, setSwap] = useState<{ from: string; to: string } | null>(null),
    [swapOverride, setSwapOverride] = useState(false);
  async function update(fn: (s: State) => State, draft = true) {
    if (!isManager) return false;
    const s = state,
      n = prepareWorkspaceUpdate(s, fn(s), month, monthDetails, draft);
    try {
      const published = Object.keys(n.months).find(
        (m) => n.months[m].status === 'published' && s.months[m]?.status !== 'published',
      );
      await remote.save(n, published);
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    }
  }
  function runGenerate() {
    if (!isManager) return;
    setBusy(true);
    setTimeout(async () => {
      try {
        const r = generate(state, month, crypto.getRandomValues(new Uint32Array(1))[0]);
        const saved = await update((s) => ({
          ...s,
          assignments: r.assignments,
          months: { ...s.months, [month]: { ...monthDetails, generated: true, status: 'draft' } },
        }));
        if (saved)
          toast.success(
            r.warnings.length
              ? t(
                  `${r.warnings.length} duties need your decision.`,
                  'יש תורנויות שממתינות להחלטה שלך.',
                )
              : t(
                  'Draft ready. Review, adjust, then publish.',
                  'הטיוטה מוכנה לבדיקה, עריכה ופרסום.',
                ),
          );
      } finally {
        setBusy(false);
      }
    }, 40);
  }
  function openDuty(b: Duty) {
    if (isManager) setSelected(b);
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
      x.extra > 20
    ) {
      toast.error(
        t(
          'Choose up to 14 days starting this month, and 0–20 extra points.',
          'יש לבחור עד 14 ימים שמתחילים בחודש זה ו־0–20 נקודות נוספות.',
        ),
      );
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
    if (touched.some((b) => b.start.slice(0, 7) !== month && state.assignments[b.id]?.primary)) {
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
      const months = { ...s.months };
      for (const m of Object.keys(months))
        if (m + '-01' < end && monthNext(m) + '-01' > x.start)
          months[m] = { ...months[m], status: 'draft' };
      return { ...s, assignments, months, specials: [...s.specials, x] };
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
    if (from === to) return;
    setSwapOverride(false);
    setSwap({ from, to });
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
        'This would give an engineer a second weekend. Edit an assignment manually if an exception is needed.',
        'ההחלפה תיצור סוף שבוע שני למהנדס. במקרה חריג יש לערוך שיבוץ ידנית.',
      ),
      availability: t('This swap conflicts with availability.', 'ההחלפה מתנגשת עם אילוצים.'),
    })[reason] ?? reason;
  async function confirmSwap() {
    if (!swap) return;
    const result = swapDraft(state, month, swap.from, swap.to, swapOverride);
    if (!result.ok) {
      toast.error(swapReason(result.reason));
      return;
    }
    if (!(await update((s) => ({ ...s, assignments: result.assignments })))) return;
    setSwap(null);
    toast.success(t('Duties swapped.', 'התורנויות הוחלפו.'));
  }
  const saveDuty: (fn: Parameters<UpdateDraft>[0]) => Promise<void> = async (fn) => {
    if (!(await update(fn))) return;
    setSelected(null);
    toast.success(t('Assignment saved to draft.', 'השיבוץ נשמר בטיוטה.'));
  };
  const removeSpecial = async () => {
    const b = selected;
    if (!b) return;
    if (
      !(await update((s) => {
        const specials = s.specials.flatMap((x) =>
          x.id !== b.specialId
            ? [x]
            : [
                { ...x, end: b.start },
                { ...x, id: crypto.randomUUID(), start: addDays(b.start, 1) },
              ].filter((x) => x.start < x.end),
        );
        const splitWeekends = b.weekendId
          ? [...new Set([...(s.splitWeekends ?? []), b.weekendId])]
          : s.splitWeekends;
        return { ...s, specials, splitWeekends };
      }))
    )
      return;
    setSelected(null);
  };
  function resetSpecialDates(month: string) {
    setSpecialStart(month + '-01');
    setSpecialEnd(month + '-02');
  }
  return {
    update,
    runGenerate,
    busy,
    resetSpecialDates,
    editor: { selected, setSelected, openDuty, save: saveDuty, removeSpecial },
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
      setSelection: setSwap,
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
