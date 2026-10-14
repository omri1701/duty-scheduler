import {tactileVisual} from '../tactile.ts';

// Presentation only. The shared gesture and caller still decide whether to commit.
export function dragPresentation(root: HTMLDivElement, source: HTMLElement, x: number, y: number, reorder: boolean) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const original = source.getBoundingClientRect();
  const rows = reorder ? [...root.querySelectorAll<HTMLElement>('[data-gesture-key]')].map(el => ({el, rect: el.getBoundingClientRect()})) : [];
  const from = rows.findIndex(row => row.el === source);
  const ghost = source.cloneNode(true) as HTMLElement;
  ghost.removeAttribute('id');
  ghost.removeAttribute('data-gesture-key');
  ghost.querySelectorAll('[id],[data-gesture-key]').forEach(el => {el.removeAttribute('id'); el.removeAttribute('data-gesture-key');});
  ghost.setAttribute('aria-hidden', 'true');
  ghost.inert = true;
  ghost.classList.remove('drag-source', 'drag-target', 'gesture-pressed');
  ghost.classList.add('mobile-drag-preview');
  ghost.dir = getComputedStyle(root).direction;
  Object.assign(ghost.style, {position: 'fixed', left: `${original.left}px`, top: `${original.top}px`, width: `${original.width}px`, height: `${original.height}px`});
  // Retain scoped calendar/team styles without an interactive second assignment.
  const wrapper = document.createElement('div');
  wrapper.className = `${reorder ? 'team-list' : 'calendar-grid'} mobile-drag-layer`;
  wrapper.setAttribute('aria-hidden', 'true');
  wrapper.append(ghost);
  document.body.append(wrapper);
  let dx = 0, dy = -6;
  function follow(px: number, py: number) {
    dx = px - x; dy = py - y - (reduced ? 0 : 6);
    ghost.style.transform = `translate3d(${dx}px,${dy}px,0) scale(${reduced ? 1 : 1.025})`;
  }
  follow(x, y);
  return {
    follow,
    hit(px: number, py: number) {
      // Use original row positions while the visual rows move aside.
      return rows.find(({rect}) => px >= rect.left && px <= rect.right && py >= rect.top && py <= rect.bottom)?.el.dataset.gestureKey ?? null;
    },
    hover(target: HTMLElement | null) {
      tactileVisual(target);
      if (!reorder) return;
      const to = rows.findIndex(row => row.el === target);
      rows.forEach(({el}, i) => {
        const shift = to > from && i > from && i <= to ? -original.height :
          to >= 0 && to < from && i >= to && i < from ? original.height : 0;
        if (el !== source) el.style.transform = shift ? `translateY(${shift}px)` : '';
      });
    },
    finish(target: HTMLElement | null, animate = true) {
      rows.forEach(({el}) => {el.style.transform = '';});
      const destination = target?.getBoundingClientRect() ?? source.getBoundingClientRect();
      if (!animate || reduced || !ghost.animate) {wrapper.remove(); return;}
      const animation = ghost.animate([
        {transform: `translate3d(${dx}px,${dy}px,0) scale(1.025)`, opacity: 1},
        {transform: `translate3d(${destination.left - original.left}px,${destination.top - original.top}px,0) scale(1)`, opacity: .1},
      ], {duration: 240, easing: 'cubic-bezier(.2,.85,.25,1)', fill: 'forwards'});
      animation.onfinish = () => wrapper.remove();
      animation.oncancel = () => wrapper.remove();
    },
  };
}
