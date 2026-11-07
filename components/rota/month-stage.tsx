'use client';
import {forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode} from 'react';
import {monthNext} from '@/lib/rota/engine';

export type MonthStageHandle = {
  /** The chevrons: the neighbour slides in. */
  go: (offset: number) => void;
  /** The month name was swiped: the next month change refreshes in place, blurred to sharp, without a slide. */
  arrive: () => void;
};
const COMMIT = .4, FLICK = .5, DURATION = 280, ARRIVE = 300;
const reduced = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A month screen that refreshes in place when the month name was swiped (owner round 4,
 * 2026-11-07): blurred at first, sharp when it arrives, its height easing to the new month's. Call
 * `mark()` just before the month changes; the hook plays the arrival once the new month rendered. */
export function useMonthArrival<T extends HTMLElement>(month: string) {
  const ref = useRef<T>(null), from = useRef<number | null>(null);
  useLayoutEffect(() => {
    const node = ref.current, height = from.current; from.current = null;
    if (node && height !== null && !reduced()) arrive(node, height);
  }, [month]);
  return {ref, mark: () => {from.current = ref.current?.offsetHeight ?? null;}};
}
function arrive(node: HTMLElement, height: number) {
  const to = node.offsetHeight, grows = Math.abs(height - to) > .5, size = grows ? [{height: `${height}px`}, {height: `${to}px`}] : [{}, {}];
  // Clip only while the height eases, so card shadows stay whole afterwards.
  const overflow = node.style.overflow;
  if (grows) node.style.overflow = 'clip';
  node.animate([{filter: 'blur(6px) saturate(.7)', opacity: .55, ...size[0]}, {filter: 'blur(0) saturate(1)', opacity: 1, ...size[1]}], {duration: ARRIVE, easing: 'cubic-bezier(.2,.8,.2,1)'})
    .finished.then(() => {if (grows) node.style.overflow = overflow;}, () => {if (grows) node.style.overflow = overflow;});
}

/** The calendar changes month by direct manipulation (owner round 2, 2026-11-07): it follows a
 * finger or a mouse drag sideways while the neighbouring month (`preview`) slides in beside it,
 * blurred and dimmed, sharpening as it arrives. Past 40% or a quick flick it springs into place and
 * becomes the month; otherwise it springs back. `go` plays the same transition for the chevrons.
 * The month name is not linked (owner round 4): it updates when the calendar lands. The stage's
 * height eases to the taller of the two months while the neighbour shows, so a six-week month is
 * seen whole and nothing below jumps when it lands. Axis-locked (vertical scroll stays native); a
 * duty hold-drag never starts it. `onChange`'s `swiped` is true for a calendar drag. */
export const MonthStage = forwardRef<MonthStageHandle, {month: string; rtl: boolean; onChange: (offset: number, swiped: boolean) => void; preview: (month: string) => ReactNode; children: ReactNode}>(
  function MonthStage({month, rtl, onChange, preview, children}, ref) {
    const stage = useRef<HTMLDivElement>(null), current = useRef<HTMLDivElement>(null), next = useRef<HTMLDivElement>(null);
    // The neighbour showing (an offset), kept per month so a new month starts without one.
    const [shown, setShown] = useState({month, offset: 0}), peek = shown.month === month ? shown.offset : 0;
    const setPeek = (offset: number) => setShown({month, offset});
    const g = useRef<{id: number; x: number; y: number; t: number; live: boolean; touch: boolean; dx: number} | null>(null), busy = useRef(false), suppress = useRef(0);
    const arrival = useRef<number | null>(null);
    // A later month comes from the reading end: the right in English, the left in Hebrew.
    const dirSign = rtl ? -1 : 1;
    const width = () => stage.current?.clientWidth || 1;
    const transition = (animate: boolean) => animate ? `transform ${DURATION}ms cubic-bezier(.2,.9,.25,1), opacity ${DURATION}ms ease, filter ${DURATION}ms ease` : 'none';
    const paint = (dx: number, offset: number, animate: boolean) => {
      const c = current.current, n = next.current, w = width();
      const progress = Math.min(1, Math.abs(dx) / w);
      if (c) {c.style.transition = transition(animate); c.style.transform = dx ? `translateX(${dx}px)` : ''; c.style.opacity = dx ? String(1 - progress * .35) : '';}
      if (n && offset) {
        n.style.transition = transition(animate);
        n.style.transform = `translateX(${dx + offset * dirSign * w}px)`;
        n.style.opacity = String(.55 + progress * .45); n.style.filter = `blur(${(1 - progress) * 5}px) saturate(${.7 + progress * .3})`;
      }
    };
    /** Eases the stage to `to` px (padding included) from wherever it is now. */
    const size = (to: number, ms: number) => {
      const s = stage.current;
      if (!s) return;
      const from = s.offsetHeight;
      if (Math.abs(from - to) < .5 && !s.style.height) return;
      s.style.transition = 'none'; s.style.height = `${from}px`;
      void s.offsetHeight;
      s.style.transition = reduced() ? 'none' : `height ${ms}ms cubic-bezier(.2,.9,.25,1)`; s.style.height = `${to}px`;
    };
    const paneHeight = (pane: HTMLDivElement | null) => (pane?.offsetHeight ?? 0) + 4;
    // The neighbour mounted: show all of it, the taller month setting the height.
    useLayoutEffect(() => {
      if (peek && next.current && current.current) size(Math.max(paneHeight(current.current), paneHeight(next.current)), 200);
    }, [peek]);
    // The month changed (a gesture, a chevron or the name): the new month is the current pane again,
    // before paint, and the stage hands its height back to the content without a jump.
    useLayoutEffect(() => {
      busy.current = false; g.current = null; paint(0, 0, false);
      const s = stage.current, held = arrival.current ?? (s?.style.height ? s.offsetHeight : null);
      const blur = arrival.current !== null; arrival.current = null;
      if (!s) return;
      s.style.transition = ''; s.style.height = '';
      if (held === null || reduced()) return;
      if (blur) arrive(s, held);
      else if (Math.abs(held - s.offsetHeight) > .5) s.animate([{height: `${held}px`}, {height: `${s.offsetHeight}px`}], {duration: 200, easing: 'cubic-bezier(.2,.9,.25,1)'});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per month change.
    }, [month]);
    function finish(offset: number, swiped: boolean) {
      // Slide the current month out and the neighbour into place, then make it the month.
      busy.current = true;
      if (reduced()) {onChange(offset, swiped); return;}
      paint(-offset * dirSign * width(), offset, true);
      if (next.current) size(paneHeight(next.current), DURATION);
      window.setTimeout(() => onChange(offset, swiped), DURATION);
    }
    useImperativeHandle(ref, () => ({
      arrive: () => {arrival.current = stage.current?.offsetHeight ?? null;},
      go: offset => {
        if (busy.current) return;
        if (reduced() || Math.abs(offset) !== 1) {onChange(offset, false); return;}
        setPeek(offset);
        // Start from just outside, blurred, then play the commit on the next frame.
        requestAnimationFrame(() => {paint(0, offset, false); requestAnimationFrame(() => finish(offset, false));});
      },
    }));
    const springBack = () => {
      paint(0, peek, !reduced());
      if (current.current) size(paneHeight(current.current), DURATION);
      window.setTimeout(() => {if (busy.current) return; setPeek(0); const s = stage.current; if (s && !g.current) {s.style.transition = ''; s.style.height = '';}}, reduced() ? 0 : DURATION);
    };
    // Dragging toward the reading start brings the next month.
    const follow = (dx: number) => {const offset = dx * dirSign < 0 ? 1 : -1; if (offset !== peek) setPeek(offset); paint(dx, offset, false);};
    const release = (dx: number, speed: number) => {
      suppress.current = performance.now() + 350;
      if (Math.abs(dx) > width() * COMMIT || (speed > FLICK && Math.abs(dx) > 40)) finish(dx * dirSign < 0 ? 1 : -1, true); else springBack();
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
