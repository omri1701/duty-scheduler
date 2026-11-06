'use client';
import {useRef, useState, type ReactNode} from 'react';
import {ChevronLeft, ChevronRight} from 'lucide-react';
import {Button} from '@/components/ui/button';
import type {Translate} from './workspace-types';

/** Which way the month last moved, for direction-aware slides (mirrored in Hebrew by CSS). */
export function useMonthDirection(month: string) {
  const [state, setState] = useState({month, direction: null as 'next' | 'prev' | null});
  if (state.month !== month) setState({month, direction: month > state.month ? 'next' : 'prev'});
  return state.month === month ? state.direction : month > state.month ? 'next' : 'prev';
}

/** The month heading every month screen shares (owner review 2026-11-07): chevrons, the name rolling
 * like an odometer when the month changes, and a sideways drag or swipe on the heading itself that
 * follows the pointer and changes month on release. */
export function MonthTitle({month, label, status, t, onChange, loading = false}: {
  month: string; label: string; status?: ReactNode; t: Translate; onChange?: (offset: number) => void; loading?: boolean;
}) {
  const rtl = t('ltr', 'rtl') === 'rtl', Prev = rtl ? ChevronRight : ChevronLeft, Next = rtl ? ChevronLeft : ChevronRight;
  const direction = useMonthDirection(month);
  const name = useRef<HTMLSpanElement>(null), drag = useRef<{id: number; x: number; y: number; dx: number; sliding: boolean} | null>(null);
  const move = (dx: number) => {if (name.current) name.current.style.transform = dx ? `translateX(${dx}px)` : '';};
  const end = (commit: boolean) => {
    const g = drag.current; drag.current = null;
    const node = name.current;
    if (!g || !node) return;
    node.removeAttribute('data-dragging');
    move(0);
    // Past a third of a thumb: the next month in the dragged direction (reading direction aware).
    if (commit && g.sliding && Math.abs(g.dx) > 48) onChange?.((g.dx < 0) !== rtl ? 1 : -1);
  };
  return <div className="month-title">
    <Button variant="ghost" size="icon" disabled={loading} aria-label={t('Previous month', 'חודש קודם')} onClick={() => onChange?.(-1)}><Prev/></Button>
    <h2 className="month-heading" data-swipe={onChange ? '' : undefined}
      onPointerDown={e => {if (!onChange || loading || !e.isPrimary || e.button !== 0 || (e.target as HTMLElement).closest('button,a')) return; drag.current = {id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, sliding: false};}}
      onPointerMove={e => {
        const g = drag.current;
        if (!g || g.id !== e.pointerId) return;
        const dx = e.clientX - g.x, dy = e.clientY - g.y;
        if (!g.sliding) {
          if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {drag.current = null; return;}
          if (Math.abs(dx) < 8) return;
          g.sliding = true; e.currentTarget.setPointerCapture(e.pointerId); name.current?.setAttribute('data-dragging', '');
        }
        // Rubber band: the name follows the pointer, then resists.
        g.dx = dx; move(Math.sign(dx) * Math.min(Math.abs(dx), 60 + Math.max(0, Math.abs(dx) - 60) * .25));
      }}
      onPointerUp={e => {if (drag.current?.id === e.pointerId) end(true);}}
      onPointerCancel={() => end(false)} onLostPointerCapture={() => {if (drag.current?.sliding) end(true);}}>
      <span className="month-roll" ref={name}><span key={month} className="month-name" data-dir={direction ?? undefined}>{label}</span></span>
      {status}
    </h2>
    <Button variant="ghost" size="icon" disabled={loading} aria-label={t('Next month', 'חודש הבא')} onClick={() => onChange?.(1)}><Next/></Button>
  </div>;
}
