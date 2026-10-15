import {tactileVisual} from '../tactile.ts';

type Boundary = {top: number; bottom: number; height: number};

export function verticalInsertion(rows: Boundary[], from: number, y: number) {
  let to = from;
  rows.forEach((row, i) => {
    const midpoint = (row.top + row.bottom) / 2;
    if (i < from && y <= midpoint) to = Math.min(to, i);
    if (i > from && y >= midpoint) to = Math.max(to, i);
  });
  return to;
}

// Heights travel with rows; measured gaps belong to the vertical slots.
export function reorderOffsets(rows: Boundary[], from: number, to: number) {
  const order = rows.map((_, i) => i);
  order.splice(to, 0, order.splice(from, 1)[0]);
  const offsets = rows.map(() => 0);
  let top = rows[0].top;
  order.forEach((index, slot) => {
    offsets[index] = top - rows[index].top;
    top += rows[index].height + (rows[slot + 1] ? rows[slot + 1].top - rows[slot].bottom : 0);
  });
  return offsets;
}

// Presentation only. The gesture and caller still decide whether to commit.
export function dragPresentation(root: HTMLDivElement, source: HTMLElement, x: number, y: number, reorder: boolean) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const original = source.getBoundingClientRect();
  const bounds = root.getBoundingClientRect();
  const rows = reorder ? [...root.querySelectorAll<HTMLElement>('[data-gesture-key]')].map(el => ({el, rect: el.getBoundingClientRect()})) : [];
  const from = rows.findIndex(row => row.el === source);
  const ghost = source.cloneNode(true) as HTMLElement;
  // cloneNode copies option attributes, not the select's live selected value.
  // Replace native controls before mounting: the preview is only a picture of
  // the current row, with no duplicate editable role or hidden checkbox input.
  const controls = source.querySelectorAll<HTMLSelectElement | HTMLInputElement | HTMLTextAreaElement>('select,input,textarea');
  ghost.querySelectorAll('select,input,textarea').forEach((clone, i) => {
    const control = controls[i];
    if (control instanceof HTMLInputElement && control.type === 'hidden') {clone.remove(); return;}
    const value = document.createElement('span');
    value.className = 'drag-control-value';
    value.textContent = control instanceof HTMLSelectElement ? control.selectedOptions[0]?.textContent ?? '' : control.value;
    const css = getComputedStyle(control);
    for (const property of ['font','color','background-color','border','border-radius','padding','width','height','min-width','max-width','box-sizing','text-align']) {
      value.style.setProperty(property, css.getPropertyValue(property));
    }
    value.style.display = 'inline-block';
    clone.replaceWith(value);
  });
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
  const visibility = source.style.visibility;
  if (reorder) source.style.visibility = 'hidden';
  let dx = 0, dy = 0;
  let animation: Animation | undefined;
  function follow(px: number, py: number) {
    dx = reorder ? 0 : px - x; dy = py - y - (reduced ? 0 : 6);
    ghost.style.transform = `translate3d(${dx}px,${dy}px,0) scale(${reduced || reorder ? 1 : 1.025})`;
  }
  function reset() {
    rows.forEach(({el}) => {
      const transition = el.style.transition;
      el.style.transition = 'none'; el.style.transform = '';
      // Reset before React commits the final order, without a reverse transition.
      void el.offsetHeight;
      el.style.transition = transition;
    });
    source.style.visibility = visibility;
    wrapper.remove();
  }
  follow(x, y);
  return {
    follow,
    hit(px: number, py: number) {
      // Only team reorders use hit(): sideways movement never invalidates a drop.
      // Original row midpoints remain stable while neighbors animate; translate
      // them by the list's scroll delta rather than measuring animated rows.
      const scrollDelta = root.getBoundingClientRect().top - bounds.top;
      const measured = rows.map(row => ({...row.rect, top: row.rect.top + scrollDelta, bottom: row.rect.bottom + scrollDelta}));
      if (py <= measured[0]?.top) return rows[0].el.dataset.gestureKey ?? null;
      if (py >= measured.at(-1)!.bottom) return rows.at(-1)!.el.dataset.gestureKey ?? null;
      const center = original.top + original.height / 2 + py - y;
      return rows[verticalInsertion(measured, from, center)]?.el.dataset.gestureKey ?? null;
    },
    hover(target: HTMLElement | null) {
      if (!reorder) {tactileVisual(target); return;}
      const to = rows.findIndex(row => row.el === target);
      const offsets = reorderOffsets(rows.map(row => row.rect), from, to < 0 ? from : to);
      rows.forEach(({el}, i) => {
        if (el !== source) el.style.transform = `translateY(${offsets[i]}px)`;
      });
    },
    finish(target: HTMLElement | null, animate = true, settled = () => {}) {
      if (animation) {animation.onfinish = null; animation.cancel();}
      const to = rows.findIndex(row => row.el === target);
      const offset = reorder ? reorderOffsets(rows.map(row => row.rect), from, to < 0 ? from : to)[from] + root.getBoundingClientRect().top - bounds.top : 0;
      const destination = target?.getBoundingClientRect() ?? source.getBoundingClientRect();
      if (reorder) this.hover(target);
      if (!animate || reduced || !ghost.animate) {reset(); settled(); return;}
      animation = ghost.animate([
        {transform: ghost.style.transform, opacity: 1},
        {transform: `translate3d(${reorder ? 0 : destination.left - original.left}px,${reorder ? offset : destination.top - original.top}px,0) scale(1)`, opacity: reorder ? 1 : .1},
      ], {duration: 240, easing: 'cubic-bezier(.2,.85,.25,1)', fill: 'forwards'});
      animation.onfinish = () => {reset(); settled();};
    },
    dispose() {if (animation) {animation.onfinish = null; animation.cancel();} reset();},
  };
}
