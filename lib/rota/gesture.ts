import {tactileTick, tactileVisual} from '../tactile.ts';
import {dragPresentation} from './drag-presentation.ts';

export type HoldDragOptions = {
  enabled: boolean; holdMs?: number; handleSelector?: string;
  onStart: (key: string) => boolean | void;
  onMove: (key: string) => boolean | void;
  onEnd: (key: string | null) => void;
  onCancel?: () => void;
};
export function attachHoldDrag(root: HTMLDivElement, getOptions: () => HoldDragOptions, ignoreUntil: {current: number}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let g: {key: string; x: number; y: number; active: boolean; touch: boolean; last: string | null; id: number; valid: boolean} | null = null;
  let pressed: HTMLElement | null = null;
  let visual: ReturnType<typeof dragPresentation> | null = null;
  function element(key: string | null) {
    return key ? [...(root.querySelectorAll?.<HTMLElement>('[data-gesture-key]') ?? [])].find(el => el.dataset.gestureKey === key) ?? null : null;
  }
  function at(x: number, y: number) {
    if (visual && root.classList.contains('team-list')) return visual.hit(x, y);
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-gesture-key]');
    return el && root.contains(el) ? el.dataset.gestureKey ?? null : null;
  }
  function clear() {
    if (timer) clearTimeout(timer);
    timer = undefined;
    pressed?.classList.remove('gesture-pressed'); pressed = null;
    root.classList.remove('gesture-active');
  }
  function cancel(animate = true) {
    visual?.finish(null, animate); visual = null;
    if (g?.active) {ignoreUntil.current = Date.now() + 700; getOptions().onCancel?.();}
    clear(); g = null;
  }
  function activate() {
    if (!g || !getOptions().enabled) {cancel(); return;}
    if (getOptions().onStart(g.key) === false) {cancel(); return;}
    g.active = true; root.classList.add('gesture-active');
    ignoreUntil.current = Date.now() + 700;
    if (g.touch && window.matchMedia?.('(max-width: 600px)').matches) {
      tactileTick();
      const source = element(g.key);
      if (source && !root.classList.contains('availability-grid')) visual = dragPresentation(root, source, g.x, g.y, root.classList.contains('team-list'));
      else tactileVisual(source);
    }
  }
  function start(x: number, y: number, touch: boolean, id: number) {
    if (!getOptions().enabled) return;
    cancel();
    const hit = document.elementFromPoint(x, y), handle = getOptions().handleSelector;
    if (touch && handle && !hit?.closest(handle)) return;
    const key = at(x, y);
    if (!key || element(key)?.matches(':disabled')) return;
    g = {key, x, y, active: false, touch, last: key, id, valid: true};
    if (touch) {pressed = element(key); pressed?.classList.add('gesture-pressed'); timer = setTimeout(activate, getOptions().holdMs ?? 360);}
  }
  function move(x: number, y: number, e: Event) {
    if (!g) return;
    if (!getOptions().enabled) {cancel(); return;}
    const moved = Math.hypot(x - g.x, y - g.y);
    if (!g.active) {
      if (g.touch && moved > 10) {cancel(); return;}
      if (!g.touch && moved > 6) activate();
    }
    if (g?.active) {
      if (e.cancelable) e.preventDefault();
      const key = at(x, y);
      if (key !== g.last) {
        g.valid = key ? getOptions().onMove(key) !== false : false;
        if (key && g.valid && g.touch && window.matchMedia?.('(max-width: 600px)').matches) {
          tactileTick();
          if (visual) visual.hover(element(key)); else tactileVisual(element(key));
        } else visual?.hover(null);
      }
      g.last = key; visual?.follow(x, y);
    }
  }
  function end(x: number, y: number, e: Event) {
    if (!g) return;
    if (!getOptions().enabled) {cancel(); return;}
    const active = g.active, target = at(x, y);
    if (active && target !== g.last) g.valid = target ? getOptions().onMove(target) !== false : false;
    visual?.finish(g.valid && target !== g.key ? element(target) : null); visual = null;
    clear(); g = null;
    if (active) {if (e.cancelable) e.preventDefault(); ignoreUntil.current = Date.now() + 700; getOptions().onEnd(target);}
  }
  function ts(e: TouchEvent) {if (e.touches.length !== 1) {cancel(); return;} const p = e.touches[0]; start(p.clientX, p.clientY, true, p.identifier);}
  function tm(e: TouchEvent) {if (!g?.touch) return; if (e.touches.length !== 1) {cancel(); return;} const p = [...e.touches].find(p => p.identifier === g!.id); if (p) move(p.clientX, p.clientY, e);}
  function te(e: TouchEvent) {if (!g?.touch) return; const p = [...e.changedTouches].find(p => p.identifier === g!.id); if (p) end(p.clientX, p.clientY, e);}
  function pd(e: PointerEvent) {if (e.pointerType === 'touch' || e.button !== 0) return; start(e.clientX, e.clientY, false, e.pointerId);}
  function pm(e: PointerEvent) {if (g && !g.touch && e.pointerId === g.id) move(e.clientX, e.clientY, e);}
  function pu(e: PointerEvent) {if (g && !g.touch && e.pointerId === g.id) end(e.clientX, e.clientY, e);}
  const cancelEvent = () => cancel();
  function keyboard(e: KeyboardEvent) {if (e.key === 'Escape' && g) {e.preventDefault(); cancel();}}
  function menu(e: Event) {if (g) e.preventDefault();}
  root.addEventListener('touchstart', ts, {passive: true});
  // Document listeners continue tracking when the finger leaves the initial row.
  document.addEventListener('touchmove', tm, {passive: false}); document.addEventListener('touchend', te, {passive: false}); document.addEventListener('touchcancel', cancelEvent);
  root.addEventListener('pointerdown', pd); root.addEventListener('contextmenu', menu);
  document.addEventListener('pointermove', pm, {passive: false}); document.addEventListener('pointerup', pu); document.addEventListener('pointercancel', cancelEvent); document.addEventListener('keydown', keyboard); window.addEventListener('blur', cancelEvent);
  return () => {
    cancel(false);
    root.removeEventListener('touchstart', ts); document.removeEventListener('touchmove', tm); document.removeEventListener('touchend', te); document.removeEventListener('touchcancel', cancelEvent);
    root.removeEventListener('pointerdown', pd); root.removeEventListener('contextmenu', menu);
    document.removeEventListener('pointermove', pm); document.removeEventListener('pointerup', pu); document.removeEventListener('pointercancel', cancelEvent); document.removeEventListener('keydown', keyboard); window.removeEventListener('blur', cancelEvent);
  };
}
