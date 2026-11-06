'use client';
import {useEffect, useRef, useState, type CSSProperties, type ReactNode} from 'react';
import {cn} from '@/lib/utils';

/** `onSelect` may answer whether the action happened: `true` leaves the row flown off (the list
 * removes it), anything else springs it back (a failure, or a sheet that asks first). */
export type SwipeAction = {label: string; icon?: ReactNode; tone?: 'danger' | 'ok' | 'neutral' | 'brand'; onSelect: () => unknown};

/** An iOS-Mail-style row: drag it sideways (finger or mouse) to reveal an action, a long swipe
 * triggers it with a fly-off, a tap elsewhere closes it. `action` sits at the inline end (drag
 * toward the inline start), `leading` at the inline start. Starts on `ignore` targets (a drag
 * handle, a popover) never swipe. One row is open at a time through `openId`/`onOpen`. */
export function SwipeRow({id, action, leading, children, openId, onOpen, disabled = false, ignore = '[data-no-swipe]', className, rtl, onClick, attrs}: {
  id: string; action?: SwipeAction; leading?: SwipeAction; children: ReactNode; openId: string | null; onOpen: (id: string | null) => void; disabled?: boolean; ignore?: string; className?: string; rtl: boolean;
  onClick?: () => void; /** Extra attributes on the root (e.g. a gesture key for reordering). */ attrs?: Record<string, string | undefined>;
}) {
  const root = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null), endActions = useRef<HTMLDivElement>(null), startActions = useRef<HTMLDivElement>(null);
  const [x, setX] = useState(0), [dragging, setDragging] = useState(false), [side, setSide] = useState<'start' | 'end' | null>(null), [busy, setBusy] = useState(false);
  const gesture = useRef<{id: number; x: number; y: number; start: number; live: boolean} | null>(null);
  const suppressClick = useRef(0), live = useRef(0);
  const open = openId === id;
  // Physical sign of a reveal: the end action moves the row toward the inline start.
  const endSign = rtl ? 1 : -1;
  const width = (which: 'start' | 'end') => (which === 'end' ? endActions : startActions).current?.offsetWidth || 96;
  const set = (value: number) => {live.current = value; setX(value);};
  useEffect(() => {if (!open && !dragging && !busy) {live.current = 0; setX(0); setSide(null);}}, [open, dragging, busy]);
  const reduced = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  function down(e: React.PointerEvent<HTMLDivElement>) {
    if (disabled || busy || (!action && !leading) || !e.isPrimary || e.button !== 0) return;
    if ((e.target as HTMLElement).closest(ignore)) return;
    gesture.current = {id: e.pointerId, x: e.clientX, y: e.clientY, start: live.current, live: false};
  }
  function move(e: React.PointerEvent<HTMLDivElement>) {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    const dx = e.clientX - g.x, dy = e.clientY - g.y;
    if (!g.live) {
      if (Math.abs(dy) > 8 && Math.abs(dy) >= Math.abs(dx)) {gesture.current = null; return;}
      if (Math.abs(dx) < 8) return;
      g.live = true; setDragging(true);
      content.current?.setPointerCapture(e.pointerId);
    }
    const raw = g.start + dx, toward = raw * endSign;
    // Toward the end action (positive) or the leading one (negative); a little resistance past either.
    const which = toward > 0 ? (action ? 'end' : null) : toward < 0 ? (leading ? 'start' : null) : null;
    setSide(which);
    if (!which) {set(0); return;}
    const w = width(which), amount = Math.abs(toward), shown = amount <= w ? amount : w + (amount - w) * .35;
    set((which === 'end' ? endSign : -endSign) * shown);
  }
  async function trigger(which: 'start' | 'end') {
    const chosen = which === 'end' ? action : leading;
    if (!chosen) return;
    onOpen(null);
    // Fly off in the swiped direction, then act; anything but success springs back.
    const full = root.current?.offsetWidth ?? 400;
    setBusy(true); set((which === 'end' ? endSign : -endSign) * full);
    let done = false;
    try {done = (await chosen.onSelect()) === true;} catch {done = false;}
    if (!done) {set(0); setSide(null);}
    setBusy(false);
  }
  function up(e: React.PointerEvent<HTMLDivElement>) {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    gesture.current = null;
    if (!g.live) return;
    setDragging(false);
    if (content.current?.hasPointerCapture(e.pointerId)) content.current.releasePointerCapture(e.pointerId);
    suppressClick.current = performance.now() + 350;
    const toward = live.current * endSign, which = toward > 0 ? 'end' : toward < 0 ? 'start' : null;
    if (!which) {onOpen(null); set(0); return;}
    const w = width(which), reveal = Math.abs(toward);
    if (reveal > w * 1.6) {void trigger(which); return;}
    if (reveal > w / 2) {onOpen(id); set((which === 'end' ? endSign : -endSign) * w);} else {onOpen(null); set(0); setSide(null);}
  }
  function cancel() {gesture.current = null; setDragging(false); if (!open) {set(0); setSide(null);}}
  const style = {'--swipe-x': `${x}px`, transition: dragging || reduced() ? 'none' : undefined} as CSSProperties;
  const button = (chosen: SwipeAction, which: 'start' | 'end') => <button type="button" tabIndex={open && side === which ? 0 : -1} className="swipe-action" data-tone={chosen.tone ?? 'neutral'}
    onClick={() => void trigger(which)}>{chosen.icon}<span>{chosen.label}</span></button>;
  return <div ref={root} {...attrs} className={cn('swipe', open && 'swipe-open', dragging && 'swipe-dragging', busy && 'swipe-busy', className)} data-swipe-row={id} data-swipe-side={side ?? undefined}>
    {leading && <div ref={startActions} className="swipe-actions swipe-actions-start" aria-hidden={!(open && side === 'start')}>{button(leading, 'start')}</div>}
    {action && <div ref={endActions} className="swipe-actions" aria-hidden={!(open && side === 'end')}>{button(action, 'end')}</div>}
    <div ref={content} className="swipe-content" style={style} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel}
      // Touch pointers start captured by the element under the finger; handing capture to this row
      // makes that element report a lost capture that bubbles here. Only this row's own loss ends the swipe.
      onLostPointerCapture={e => {if (e.target === e.currentTarget && gesture.current?.live) cancel();}}
      onClickCapture={e => {
        if (performance.now() < suppressClick.current) {e.preventDefault(); e.stopPropagation(); return;}
        if (open) {e.preventDefault(); e.stopPropagation(); onOpen(null);}
      }}
      onClick={onClick}>
      {children}
    </div>
  </div>;
}
