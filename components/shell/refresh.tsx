'use client';
import {useCallback, useEffect, useRef} from 'react';
import {RefreshCw} from 'lucide-react';

const PULL = 72, MAX = 116, MIN_SPIN = 650;

/** Pull down at the top of a phone screen, or tap the logo, to reload the team (owner review
 * 2026-11-07). One floating spinner shows both: it rides the finger, then spins until the reload
 * ends. It is fixed above the page, so nothing on the page moves. */
export function useRefresh(onRefresh: () => Promise<unknown>, {pull = true, label}: {pull?: boolean; label: string}) {
  const node = useRef<HTMLDivElement>(null), busy = useRef(false), latest = useRef(onRefresh);
  useEffect(() => {latest.current = onRefresh;});
  const show = (state: 'idle' | 'pulling' | 'refreshing', px = 0) => {
    const el = node.current;
    if (!el) return;
    el.dataset.state = state;
    el.style.setProperty('--pull', `${px}px`);
    el.style.setProperty('--pull-turn', `${Math.min(1, px / PULL) * 270}deg`);
    el.style.setProperty('--pull-o', String(Math.min(1, px / 40)));
    el.dataset.ready = px >= PULL ? 'true' : 'false';
  };
  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true; show('refreshing', PULL);
    const started = performance.now();
    try {await latest.current();} catch {/* the workspace shows its own error */}
    finally {
      // A short spin reads as "done" even when the reload is instant.
      const rest = MIN_SPIN - (performance.now() - started);
      if (rest > 0) await new Promise(resolve => setTimeout(resolve, rest));
      busy.current = false; show('idle');
    }
  }, []);
  useEffect(() => {
    if (!pull) return;
    let start: {x: number; y: number; t: number} | null = null, active = false, distance = 0;
    const blocked = (target: EventTarget | null) => !!(target as Element | null)?.closest?.('.tabbar,.sheet,[role=dialog],[role=alertdialog],input,textarea,select,[contenteditable],.month-heading')
      || !!document.querySelector('[role=dialog],[role=alertdialog],.mobile-drag-preview');
    const down = (e: TouchEvent) => {
      start = null; active = false;
      if (busy.current || e.touches.length !== 1 || window.scrollY > 0 || blocked(e.target)) return;
      start = {x: e.touches[0].clientX, y: e.touches[0].clientY, t: performance.now()};
    };
    const move = (e: TouchEvent) => {
      if (!start || e.touches.length !== 1) return;
      const dx = e.touches[0].clientX - start.x, dy = e.touches[0].clientY - start.y;
      if (!active) {
        // Only a quick, mostly vertical pull downwards: a hold (calendar drag, range select) or a swipe is not a refresh.
        if (dy < -6 || Math.abs(dx) > 10 || (dy < 10 && performance.now() - start.t > 250)) {start = null; return;}
        if (dy < 10 || Math.abs(dx) > dy || window.scrollY > 0 || document.querySelector('.mobile-drag-preview')) return;
        active = true;
      }
      distance = Math.min(MAX, (dy - 10) * .55);
      show('pulling', distance);
    };
    const up = () => {
      const pulled = active && distance >= PULL;
      start = null; active = false; distance = 0;
      if (pulled) void refresh(); else if (!busy.current) show('idle');
    };
    window.addEventListener('touchstart', down, {passive: true});
    window.addEventListener('touchmove', move, {passive: true});
    window.addEventListener('touchend', up);
    window.addEventListener('touchcancel', up);
    return () => {
      window.removeEventListener('touchstart', down); window.removeEventListener('touchmove', move);
      window.removeEventListener('touchend', up); window.removeEventListener('touchcancel', up);
    };
  }, [pull, refresh]);
  const indicator = <div ref={node} className="refresh-indicator" data-state="idle" role="status" aria-live="polite">
    <span className="refresh-bubble"><RefreshCw aria-hidden="true"/></span>
    <span className="sr-only refresh-label">{label}</span>
  </div>;
  return {indicator, refresh};
}
