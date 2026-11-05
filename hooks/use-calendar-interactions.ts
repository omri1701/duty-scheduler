'use client';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useHoldDrag } from '@/hooks/use-hold-drag';
import { useMobileLayout } from '@/hooks/use-mobile-layout';
import { publishedSwapDuties, eligibleSwapTarget, swapTargetBlock, swapBlockText, type SwapBlock, type SwapConflict } from '@/lib/supabase/swaps';
import { ownerMonth, swapDraft, type State, type Duty } from '@/lib/rota/engine';
import { shortDate } from '@/lib/date-format';
import type { TeamWorkspace } from '@/hooks/use-team-workspace';
import type { DutySelection } from '@/components/rota/workspace-types';

// The ref and click-suppression lifecycle are shared by draft and published gestures.
export function useCalendarInteractions({
  remote,
  state,
  month,
  tab,
  requesting,
  today,
  publication,
  duties,
  monthDetails,
  openDuty,
  startSwap,
  editPublished,
  lang,
}: {
  remote: TeamWorkspace;
  state: State;
  month: string;
  tab: string;
  requesting: boolean;
  today: string;
  publication: string | null | undefined;
  duties: Duty[];
  monthDetails: State['months'][string];
  openDuty: (duty: Duty) => void;
  startSwap: (from: string, to: string) => void;
  /** Admins only: opens Edit duty for an editable published duty, else returns false. */
  editPublished?: (day: string) => boolean;
  lang: 'en' | 'he';
}) {
  const meId = remote.user!.id;
  const mobile = useMobileLayout();
  const [requestSelection, setRequestSelection] = useState<DutySelection | null>(null),
    [keyboardSource, setKeyboardSource] = useState<string | null>(null);
  const [dragFrom, setDragFrom] = useState<string | null>(null),
    [dragOver, setDragOver] = useState<string | null>(null);
  const dragSource = useRef<string | null>(null), dragHover = useRef<string | null>(null);
  const publishedDuties = publishedSwapDuties(remote.snapshot!, month, today);
  // Engineers offer their own duty; admins may also propose a swap between any two members.
  const swapSourceDays = new Set(
    publishedDuties.filter((d) => remote.isAdmin || d.primary_id === meId).map((d) => d.day),
  );
  const publishedDuty = (day: string) => publishedDuties.find((d) => d.day === day);
  const eligible = (from: string, to: string) =>
    swapSourceDays.has(from) && eligibleSwapTarget(publishedDuty(from), publishedDuty(to));
  // While a swap is being chosen, each eligible target's availability is read once (who and
  // which date, never the note) so a day the server would refuse is greyed before the pick.
  const source = requesting ? keyboardSource ?? dragFrom : null;
  const conflicts = useTargetConflicts(remote, source ? publishedDuty(source)?.id : undefined,
    source ? publishedDuties.filter((d) => eligible(source, d.day)).map((d) => d.id) : []);
  /** Why `to` can't be picked from `from`; null when it can, undefined when it isn't a candidate. */
  function swapBlock(from: string, to: string): SwapBlock | null | undefined {
    const a = publishedDuty(from), b = publishedDuty(to);
    if (!requesting || !swapSourceDays.has(from)) return undefined;
    // A past day of this publication: its duty can no longer be swapped.
    if (!b) {
      const row = remote.snapshot!.assignments.find((d) => d.day === to && d.publication_id === publication && d.primary_id);
      return row && to < today && to !== from ? { kind: 'past' } : undefined;
    }
    if (!eligible(from, to)) return undefined;
    // Unchecked yet (or the check failed): the dialog checks again and the server rechecks.
    const found = conflicts.get(b.id);
    return swapTargetBlock(remote.snapshot!, month, a!, b, found ?? []);
  }
  const requestTarget = (from: string, to: string) => eligible(from, to) && swapBlock(from, to) === null;
  const draftTarget = (from: string, to: string) => {
    const result = swapDraft(state, month, from, to);
    // Policy exceptions open manager review; structural failures remain invalid.
    return result.ok || result.reason === 'availability' || result.reason === 'weekend-limit' || result.reason === 'no-weekends';
  };
  function blockText(block: SwapBlock, from: string) {
    const members = remote.snapshot!.members;
    return swapBlockText(block, { me: meId, lang, sourceOwner: publishedDuty(from)?.primary_id ?? null,
      name: (id) => members.find((m) => m.id === id)?.name ?? (lang === 'he' ? 'חבר צוות' : 'A team member'),
      day: (d) => shortDate(d, lang) });
  }
  /** The reason a target is greyed, for its tooltip and accessible name. */
  const swapHint = (from: string, to: string) => {
    const block = swapBlock(from, to);
    return block ? blockText(block, from) : null;
  };
  /** Announces why a target is greyed; true when it was. */
  function explainBlock(from: string, to: string) {
    const block = swapBlock(from, to);
    if (!block) return false;
    toast.info(blockText(block, from), { id: 'swap-block' });
    return true;
  }
  function finishCalendarSwap(from: string, to: string) {
    if (requesting) {
      if (requestTarget(from, to)) {
        setRequestSelection({ from, to });
        setKeyboardSource(null);
      }
    } else startSwap(from, to);
  }
  function selectCalendarDuty(b: Duty) {
    if(remote.readOnly || ownerMonth(b) !== month)return;
    if (!requesting) {
      openDuty(b);
      return;
    }
    if (keyboardSource && requestTarget(keyboardSource, b.id)) {
      finishCalendarSwap(keyboardSource, b.id);
      return;
    }
    // A greyed target says why instead of opening anything (a tap hint on phones).
    if (keyboardSource && keyboardSource !== b.id && explainBlock(keyboardSource, b.id)) return;
    // A regular press (or Enter) edits for admins; a swap starts by drag or from the editor's
    // "Swap with another duty", which selects this duty so the next press picks the second one.
    if (keyboardSource !== b.id && editPublished?.(b.id)) {
      setKeyboardSource(null);
      return;
    }
    if (swapSourceDays.has(b.id)) setKeyboardSource(keyboardSource === b.id ? null : b.id);
  }
  const { bindContainer: dragContainer, ignoreClick: ignoreDragClick } = useHoldDrag({
    enabled:
      !remote.saving && !remote.readOnly &&
      tab === 'schedule' &&
      (requesting ? !!publication : monthDetails.status === 'draft'),
    onStart: (key) => {
      const b = duties.find((b) => b.id === key);
      if (
        requesting
          ? !swapSourceDays.has(key)
          : !b || ownerMonth(b) !== month || !state.assignments[key]?.primary
      ) {
        dragSource.current = null;
        return false;
      }
      setKeyboardSource(null);
      dragSource.current = key;
      dragHover.current = null;
      setDragFrom(key);
    },
    onMove: (key) => {
      dragHover.current = key;
      const valid = duties.some(b => b.id === key && ownerMonth(b) === month) && !!dragSource.current && (requesting ? requestTarget(dragSource.current, key) : !mobile || draftTarget(dragSource.current, key));
      setDragOver(valid ? key : null);
      return valid;
    },
    onEnd: (key) => {
      const source = dragSource.current, hovered = dragHover.current;
      dragSource.current = null;
      dragHover.current = null;
      setDragFrom(null);
      setDragOver(null);
      // A drop on a greyed day (the gesture reports no valid target) says why.
      if (source && requesting && !key && hovered && hovered !== source && explainBlock(source, hovered)) return;
      if (source && key && duties.some(b => b.id === key && ownerMonth(b) === month) && (requesting || !mobile || draftTarget(source, key))) finishCalendarSwap(source, key);
    },
    onCancel: () => {
      dragSource.current = null;
      dragHover.current = null;
      setDragFrom(null);
      setDragOver(null);
    },
  });
  function resetSelection() {
    dragSource.current = null;
    setDragFrom(null);
    setDragOver(null);
    setKeyboardSource(null);
    setRequestSelection(null);
  }
  function cancelKeyboard() {
    setKeyboardSource(null);
    setDragFrom(null);
    setDragOver(null);
  }
  return {
    requestSelection,
    setRequestSelection,
    keyboardSource,
    setKeyboardSource,
    dragFrom,
    dragOver,
    swapSourceDays,
    publishedDuty,
    requestTarget,
    swapBlock,
    swapHint,
    dragContainer,
    ignoreDragClick,
    selectCalendarDuty,
    resetSelection,
    cancelKeyboard,
  };
}
// Conflicts per target duty id for one source; empty while unread. The revision changes with
// every constraint or schedule edit, so it is the refresh trigger.
function useTargetConflicts(remote: TeamWorkspace, from: string | undefined, targets: string[]) {
  const key = from ? `${from}|${remote.snapshot?.revision}|${targets.join(',')}` : '';
  const [result, setResult] = useState<{ key: string; conflicts: Map<string, SwapConflict[]> } | null>(null);
  const check = remote.swapAvailability;
  useEffect(() => {
    if (!from || !targets.length) return;
    let alive = true;
    const conflicts = new Map<string, SwapConflict[]>();
    // One read per target; a failed read leaves that target to the dialog's own check.
    for (const to of targets)
      check(from, to).then((found) => {
        if (!alive) return;
        conflicts.set(to, found);
        setResult({ key, conflicts: new Map(conflicts) });
      }, () => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- check is recreated each render; key is the trigger.
  }, [key]);
  return key && result?.key === key ? result.conflicts : new Map<string, SwapConflict[]>();
}
export type CalendarInteractions = ReturnType<typeof useCalendarInteractions>;
