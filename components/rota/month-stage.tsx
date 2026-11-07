'use client';
import {forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode} from 'react';
import {monthNext} from '@/lib/rota/engine';

export type MonthStageHandle = {
  go: (offset: number) => void;
  /** A drag that started elsewhere (the month heading) moves the calendar the same way. */
  drag: (dx: number) => void;
  /** Ends that drag: commits past the threshold or on a flick (`speed` in px/ms), else springs back. */
  release: (dx: number, speed: number, threshold?: number) => void;
};
const COMMIT = .4, FLICK = .5, DURATION = 280;
const reduced = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The month changes by direct manipulation (owner round 2, 2026-11-07): the calendar follows a
 * finger or a mouse drag sideways while the neighbouring month (`preview`) slides in beside it,
 * blurred and dimmed, sharpening as it arrives. Past 40% or a quick flick it springs into place and
 * becomes the month; otherwise it springs back. `go` plays the same transition for the chevrons.
 * Axis-locked (vertical scroll stays native); a duty hold-drag never starts it. */
export const MonthStage = forwardRef<MonthStageHandle, {month: string; rtl: boolean; onChange: (offset: number) => void; preview: (month: string) => ReactNode; children: ReactNode}>(
  function MonthStage({month, rtl, onChange, preview, children}, ref) {
    const stage = useRef<HTMLDivElement>(null), current = useRef<HTMLDivElement>(null), next = useRef<HTMLDivElement>(null);
    const [peek, setPeek] = useState<number>(0);
    const g = useRef<{id: number; x: number; y: number; t: number; live: boolean; touch: boolean; dx: number} | null>(null), busy = useRef(false), suppress = useRef(0);
    // A later month comes from the reading end: the right in English, the left in Hebrew.
    const dirSign = rtl ? -1 : 1;
    const width = () => stage.current?.clientWidth || 1;
    const paint = (dx: number, offset: number, animate: boolean) => {
      const c = current.current, n = next.current, w = width();
      const progress = Math.min(1, Math.abs(dx) / w), transition = animate ? `transform ${DURATION}ms cubic-bezier(.2,.9,.25,1), opacity ${DURATION}ms ease, filter ${DURATION}ms ease` : 'none';
      if (c) {c.style.transition = transition; c.style.transform = dx ? `translateX(${dx}px)` : ''; c.style.opacity = String(1 - progress * .35);}
      if (n && offset) {
        n.style.transition = transition;
        n.style.transform = `translateX(${dx + offset * dirSign * w}px)`;
        n.style.opacity = String(.55 + progress * .45); n.style.filter = `blur(${(1 - progress) * 5}px) saturate(${.7 + progress * .3})`;
      }
    };
    // The month changed (a gesture or a chevron): the new month is the current pane again, before paint.
    useLayoutEffect(() => {busy.current = false; g.current = null; paint(0, 0, false); setPeek(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per month change.
    }, [month]);
    function finish(offset: number) {
      // Slide the current month out and the neighbour into place, then make it the month.
      busy.current = true;
      if (reduced()) {onChange(offset); return;}
      paint(-offset * dirSign * width(), offset, true);
      window.setTimeout(() => onChange(offset), DURATION);
    }
    useImperativeHandle(ref, () => ({drag: dx => {if (!busy.current) follow(dx);}, release: (dx, speed, threshold) => {if (!busy.current) {if (dx) release(dx, speed, threshold); else springBack();}}, go: offset => {
      if (busy.current) return;
      if (reduced() || Math.abs(offset) !== 1) {onChange(offset); return;}
      setPeek(offset);
      // Start from just outside, blurred, then play the commit on the next frame.
      requestAnimationFrame(() => {paint(0, offset, false); requestAnimationFrame(() => finish(offset));});
    }}));
    const springBack = () => {const offset = peek; paint(0, offset, !reduced()); window.setTimeout(() => {if (!busy.current) setPeek(0);}, reduced() ? 0 : DURATION);};
    // Dragging toward the reading start brings the next month.
    const follow = (dx: number) => {const offset = dx * dirSign < 0 ? 1 : -1; if (offset !== peek) setPeek(offset); paint(dx, offset, false);};
    // `threshold`: a drag from the short month heading commits sooner than one across the calendar.
    const release = (dx: number, speed: number, threshold = width() * COMMIT) => {
      suppress.current = performance.now() + 350;
      if (Math.abs(dx) > threshold || (speed > FLICK && Math.abs(dx) > 40)) finish(dx * dirSign < 0 ? 1 : -1); else springBack();
    };
    return <div ref={stage} className="month-stage"
      onPointerDown={e => {
        if (busy.current || !e.isPrimary || e.button !== 0) return;
        const target = e.target as HTMLElement, touch = e.pointerType === 'touch';
        // A mouse press on a duty that can be dragged belongs to the duty drag.
        if (!touch && target.closest('.can-swap,button:not(.day-cell),a,input,select')) return;
        g.current = {id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), live: false, touch, dx: 0};
      }}
      onPointerMove={e => {
        const s = g.current;
        if (!s || s.id !== e.pointerId) return;
        const dx = e.clientX - s.x, dy = e.clientY - s.y;
        if (!s.live) {
          if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {g.current = null; return;}
          if (Math.abs(dx) < 12) return;
          // A finger that rested first is holding a duty, not turning the page.
          if ((s.touch && performance.now() - s.t > 300) || stage.current?.querySelector('.gesture-active,.mobile-drag-preview')) {g.current = null; return;}
          s.live = true; e.currentTarget.setPointerCapture(e.pointerId);
        }
        s.dx = dx; follow(dx);
      }}
      onPointerUp={e => {
        const s = g.current; g.current = null;
        if (!s || s.id !== e.pointerId || !s.live) return;
        release(s.dx, Math.abs(s.dx) / Math.max(1, performance.now() - s.t));
      }}
      onPointerCancel={() => {if (g.current?.live) springBack(); g.current = null;}}
      onClickCapture={e => {if (busy.current || performance.now() < suppress.current) {e.preventDefault(); e.stopPropagation();}}}>
      <div ref={current} className="month-pane">{children}</div>
      {peek !== 0 && <div ref={next} className="month-pane month-peek" aria-hidden="true" inert style={{transform: `translateX(${peek * dirSign * 100}%)`, opacity: .55, filter: 'blur(5px) saturate(.7)'}}>{preview(monthNext(month, peek))}</div>}
    </div>;
  });
