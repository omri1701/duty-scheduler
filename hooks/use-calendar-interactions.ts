'use client';
import { useRef, useState } from 'react';
import { useHoldDrag } from '@/hooks/use-hold-drag';
import { publishedSwapDuties, eligibleSwapTarget } from '@/lib/supabase/swaps';
import { todayIsrael } from '@/lib/supabase/snapshot';
import { ownerMonth, type State, type Duty } from '@/lib/rota/engine';
import type { TeamWorkspace } from '@/hooks/use-team-workspace';
import type { DutySelection } from '@/components/rota/workspace-types';

// The ref and click-suppression lifecycle are shared by draft and published gestures.
export function useCalendarInteractions({
  remote,
  state,
  month,
  tab,
  requesting,
  publication,
  duties,
  monthDetails,
  openDuty,
  startSwap,
}: {
  remote: TeamWorkspace;
  state: State;
  month: string;
  tab: string;
  requesting: boolean;
  publication: string | null | undefined;
  duties: Duty[];
  monthDetails: State['months'][string];
  openDuty: (duty: Duty) => void;
  startSwap: (from: string, to: string) => void;
}) {
  const meId = remote.user!.id;
  const [requestSelection, setRequestSelection] = useState<DutySelection | null>(null),
    [keyboardSource, setKeyboardSource] = useState<string | null>(null);
  const [dragFrom, setDragFrom] = useState<string | null>(null),
    [dragOver, setDragOver] = useState<string | null>(null);
  const dragSource = useRef<string | null>(null);
  const publishedDuties = publishedSwapDuties(remote.snapshot!, month, todayIsrael());
  const ownPublishedDays = new Set(
    publishedDuties.filter((d) => d.primary_id === meId).map((d) => d.day),
  );
  const publishedDuty = (day: string) => publishedDuties.find((d) => d.day === day);
  const requestTarget = (from: string, to: string) =>
    ownPublishedDays.has(from) && eligibleSwapTarget(publishedDuty(from), publishedDuty(to));
  function finishCalendarSwap(from: string, to: string) {
    if (requesting) {
      if (requestTarget(from, to)) {
        setRequestSelection({ from, to });
        setKeyboardSource(null);
      }
    } else startSwap(from, to);
  }
  function selectCalendarDuty(b: Duty) {
    if (!requesting) {
      openDuty(b);
      return;
    }
    if (keyboardSource && requestTarget(keyboardSource, b.id)) {
      finishCalendarSwap(keyboardSource, b.id);
      return;
    }
    if (ownPublishedDays.has(b.id)) setKeyboardSource(keyboardSource === b.id ? null : b.id);
  }
  const { bindContainer: dragContainer, ignoreClick: ignoreDragClick } = useHoldDrag({
    enabled:
      !remote.saving &&
      tab === 'schedule' &&
      (requesting ? !!publication : monthDetails.status === 'draft'),
    onStart: (key) => {
      const b = duties.find((b) => b.id === key);
      if (
        requesting
          ? !ownPublishedDays.has(key)
          : !b || ownerMonth(b) !== month || !state.assignments[key]?.primary
      ) {
        dragSource.current = null;
        return;
      }
      setKeyboardSource(null);
      dragSource.current = key;
      setDragFrom(key);
    },
    onMove: (key) => {
      if (dragSource.current)
        setDragOver(!requesting || requestTarget(dragSource.current, key) ? key : null);
    },
    onEnd: (key) => {
      const source = dragSource.current;
      dragSource.current = null;
      setDragFrom(null);
      setDragOver(null);
      if (source && key) finishCalendarSwap(source, key);
    },
    onCancel: () => {
      dragSource.current = null;
      setDragFrom(null);
      setDragOver(null);
    },
  });
  function resetSelection() {
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
    ownPublishedDays,
    publishedDuty,
    requestTarget,
    dragContainer,
    ignoreDragClick,
    selectCalendarDuty,
    resetSelection,
    cancelKeyboard,
  };
}
export type CalendarInteractions = ReturnType<typeof useCalendarInteractions>;
