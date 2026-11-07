'use client';
import {useLayoutEffect, useRef, useState, type ReactNode} from 'react';
import {ChevronLeft, ChevronRight} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {monthNext} from '@/lib/rota/engine';
import {calendarMonthLabel} from '@/lib/rota/calendar-dates';
import type {Translate} from './workspace-types';

/** Which way the month last moved, for direction-aware slides (mirrored in Hebrew by CSS). */
export function useMonthDirection(month: string) {
  const [state, setState] = useState({month, direction: null as 'next' | 'prev' | null});
  if (state.month !== month) setState({month, direction: month > state.month ? 'next' : 'prev'});
  return state.month === month ? state.direction : month > state.month ? 'next' : 'prev';
}

const SLIDE = 220, GAP = 24;
const reduced = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The month heading every month screen shares. Chevrons roll the name like an odometer. Dragging
 * the name moves only the name (owner round 4, 2026-11-07: the name and calendar swipes are
 * separate): the neighbouring month's name follows the finger and slides in, blurred at first and
 * sharp when it arrives. Past the threshold or on a flick the month changes (`onSwipe`, so the
 * screen can refresh in place without a slide); a short drag snaps back. `arrival` is how the name
 * changes when something else changed the month: `roll` (chevrons) or `blur` (a calendar swipe). */
export function MonthTitle({month, label, status, t, onChange, onSwipe, arrival = 'roll', loading = false}: {
  month: string; label: string; status?: ReactNode; t: Translate; onChange?: (offset: number) => void;
  onSwipe?: (offset: number) => void; arrival?: 'roll' | 'blur'; loading?: boolean;
}) {
  const rtl = t('ltr', 'rtl') === 'rtl', Prev = rtl ? ChevronRight : ChevronLeft, Next = rtl ? ChevronLeft : ChevronRight;
  const direction = useMonthDirection(month);
  // The month the name slid to: it already shows, so it arrives without another animation.
  const [slidTo, setSlidTo] = useState<string | null>(null);
  // The neighbouring name showing (an offset), kept per month so a new month starts without one.
  const [shown, setShown] = useState({month, offset: 0}), peek = shown.month === month ? shown.offset : 0;
  const setPeek = (offset: number) => setShown({month, offset});
  const roll = useRef<HTMLSpanElement>(null), name = useRef<HTMLSpanElement>(null), next = useRef<HTMLSpanElement>(null);
  const drag = useRef<{id: number; x: number; y: number; t: number; dx: number; sliding: boolean} | null>(null), busy = useRef(false);
  // A later month comes from the reading end: the right in English, the left in Hebrew.
  const dirSign = rtl ? -1 : 1;
  const metrics = () => {
    const current = name.current?.offsetWidth ?? 0, incoming = next.current?.offsetWidth ?? current;
    const centred = !!roll.current?.parentElement && getComputedStyle(roll.current.parentElement).justifyContent === 'center';
    return {current, incoming, slot: Math.max(current, incoming) + GAP, centred};
  };
  const paint = (dx: number, offset: number, animate: boolean) => {
    const c = name.current, n = next.current, r = roll.current;
    if (!c || !r) return;
    const {current, incoming, slot, centred} = metrics(), progress = Math.min(1, Math.abs(dx) / slot);
    // While a name slides, the heading between the chevrons is the window (soft edges, the status
    // chip faded) so neither name is cut at its own box.
    if (dx || offset) r.parentElement?.setAttribute('data-sliding', ''); else r.parentElement?.removeAttribute('data-sliding');
    const transition = animate ? `transform ${SLIDE}ms cubic-bezier(.2,.9,.25,1), opacity ${SLIDE}ms ease, filter ${SLIDE}ms ease` : 'none';
    c.style.transition = transition; c.style.transform = dx ? `translateX(${dx}px)` : '';
    c.style.opacity = dx ? String(1 - progress * .8) : ''; c.style.filter = dx ? `blur(${progress * 4}px)` : '';
    if (!n || !offset) return;
    // The incoming name lands where it will sit: centred on phones, at the start on PC.
    const base = centred ? (current - incoming) / 2 * dirSign : 0;
    n.style.transition = transition;
    n.style.transform = `translateX(${base + dx + offset * dirSign * slot}px)`;
    n.style.opacity = String(.35 + progress * .65); n.style.filter = `blur(${(1 - progress) * 4}px)`;
  };
  const offsetOf = (dx: number) => (dx < 0) !== rtl ? 1 : -1;
  // Beyond one slot the name rubber-bands.
  const band = (dx: number, slot: number) => Math.sign(dx) * (Math.abs(dx) <= slot ? Math.abs(dx) : slot + (Math.abs(dx) - slot) * .2);
  const last = useRef(0);
  // The incoming name mounts on the first move; paint it where the finger already is.
  useLayoutEffect(() => {if (peek) paint(last.current, peek, false);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- paints the freshly mounted neighbour.
  }, [peek]);
  // A new month (any cause): the name is back in place.
  useLayoutEffect(() => {busy.current = false; last.current = 0; paint(0, 0, false);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per month change.
  }, [month]);
  const end = (commit: boolean) => {
    const g = drag.current; drag.current = null;
    roll.current?.removeAttribute('data-dragging');
    if (!g?.sliding) return;
    const {slot} = metrics(), speed = Math.abs(g.dx) / Math.max(1, performance.now() - g.t), offset = offsetOf(g.dx);
    if (commit && (Math.abs(g.dx) > Math.min(48, slot * .45) || (speed > .5 && Math.abs(g.dx) > 20))) {
      busy.current = true;
      const land = () => {setSlidTo(monthNext(month, offset)); (onSwipe ?? onChange)?.(offset);};
      if (reduced()) {land(); return;}
      paint(-offset * dirSign * slot, offset, true);
      window.setTimeout(land, SLIDE);
      return;
    }
    paint(0, peek, !reduced());
    window.setTimeout(() => {if (!busy.current && !drag.current) {setPeek(0); paint(0, 0, false);}}, reduced() ? 0 : SLIDE);
  };
  const mode = slidTo === month ? null : arrival;
  return <div className="month-title" data-swipe={onChange ? '' : undefined}
      onPointerDown={e => {if (!onChange || loading || busy.current || !e.isPrimary || e.button !== 0 || (e.target as HTMLElement).closest('a')) return; drag.current = {id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), dx: 0, sliding: false};}}
      onPointerMove={e => {
        const g = drag.current;
        if (!g || g.id !== e.pointerId) return;
        const dx = e.clientX - g.x, dy = e.clientY - g.y;
        if (!g.sliding) {
          if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {drag.current = null; return;}
          if (Math.abs(dx) < 8) return;
          g.sliding = true; e.currentTarget.setPointerCapture(e.pointerId); roll.current?.setAttribute('data-dragging', '');
        }
        g.dx = dx;
        const offset = offsetOf(dx), shown = band(dx, metrics().slot);
        last.current = shown;
        if (offset !== peek) setPeek(offset);
        paint(shown, offset, false);
      }}
      onPointerUp={e => {if (drag.current?.id === e.pointerId) end(true);}}
      onPointerCancel={() => end(false)} onLostPointerCapture={e => {
        // A touch starts captured by the text under the finger; that release bubbles here when the
        // heading takes the capture and must not end the swipe (the mobile "nothing happens" bug).
        if (e.target === e.currentTarget && drag.current?.sliding) end(true);}}>
    <Button variant="ghost" size="icon" disabled={loading} aria-label={t('Previous month', 'חודש קודם')} onClick={() => onChange?.(-1)}><Prev/></Button>
    <h2 className="month-heading" data-swipe={onChange ? '' : undefined}>
      <span className="month-roll" ref={roll}>
        <span key={month} ref={name} className="month-name" data-dir={mode === 'roll' ? direction ?? undefined : undefined} data-arrive={mode === 'blur' && direction ? '' : undefined}>{label}</span>
        {peek !== 0 && <span ref={next} className="month-name-peek" aria-hidden="true">{calendarMonthLabel(monthNext(month, peek), rtl ? 'he' : 'en')}</span>}
      </span>
      {status}
    </h2>
    <Button variant="ghost" size="icon" disabled={loading} aria-label={t('Next month', 'חודש הבא')} onClick={() => onChange?.(1)}><Next/></Button>
  </div>;
}
