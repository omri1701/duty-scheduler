// No queued patterns: rapid crossings are dropped, never replayed later.
let lastTick = -Infinity;
export function tactileTick() {
  if (typeof window === 'undefined' || document.visibilityState === 'hidden' ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  const now = performance.now();
  if (now - lastTick < 80) return false;
  lastTick = now;
  try {
    return typeof navigator.vibrate === 'function' &&
      navigator.userActivation?.hasBeenActive !== false && navigator.vibrate(8);
  } catch { return false; }
}

export function tactileVisual(element: HTMLElement | null) {
  if (!element || !window.matchMedia('(max-width: 600px)').matches ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  element.animate?.([{transform: 'scale(.97)'}, {transform: 'scale(1)'}],
    {duration: 180, easing: 'cubic-bezier(.2,.8,.25,1)'});
}
