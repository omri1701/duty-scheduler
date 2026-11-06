'use client';
import {useEffect, useRef, useState, type CSSProperties, type ReactNode} from 'react';
import {cn} from '@/lib/utils';

export type SwipeAction = {label: string; icon?: ReactNode; tone?: 'danger' | 'ok' | 'neutral'; onSelect: () => void};

/** An iOS-Mail-style row: drag it sideways (finger or mouse) to reveal an action at the inline
 * end; a long swipe triggers the action; a tap elsewhere closes it. Starts on `ignore` targets
 * (a drag handle, a popover) never swipe. One row is open at a time through `openId`/`onOpen`. */
export function SwipeRow({id, action, children, openId, onOpen, disabled = false, ignore = '[data-no-swipe]', className, rtl, onClick, attrs}: {
  id: string; action?: SwipeAction; children: ReactNode; openId: string | null; onOpen: (id: string | null) => void; disabled?: boolean; ignore?: string; className?: string; rtl: boolean;
  onClick?: () => void; /** Extra attributes on the root (e.g. a gesture key for reordering). */ attrs?: Record<string, string | undefined>;
}) {
  const content = useRef<HTMLDivElement>(null), actions = useRef<HTMLDivElement>(null);
  const [x, setX] = useState(0), [dragging, setDragging] = useState(false);
  const gesture = useRef<{id: number; x: number; y: number; start: number; moved: boolean; live: boolean} | null>(null);
  const suppressClick = useRef(0);
  const open = openId === id;
  const width = () => actions.current?.offsetWidth ?? 96;
  // The reveal direction: the action sits at the inline end, so the row moves toward the inline start.
  const sign = rtl ? 1 : -1;
  useEffect(() => {if (!open && !dragging) setX(0);}, [open, dragging]);
  useEffect(() => {if (open) setX(sign * width());}, [open, sign]);
  const reduced = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  function down(e: React.PointerEvent<HTMLDivElement>) {
    if (disabled || !action || !e.isPrimary || e.button !== 0) return;
    if ((e.target as HTMLElement).closest(ignore)) return;
    gesture.current = {id: e.pointerId, x: e.clientX, y: e.clientY, start: x, moved: false, live: false};
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
    g.moved = true;
    // Only toward the action; a little resistance past it.
    const raw = g.start + dx, toward = raw * sign;
    const w = width();
    const next = toward <= 0 ? 0 : toward <= w ? toward : w + (toward - w) * .35;
    setX(sign * next);
  }
  function up(e: React.PointerEvent<HTMLDivElement>) {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    gesture.current = null;
    if (!g.live) return;
    setDragging(false);
    if (content.current?.hasPointerCapture(e.pointerId)) content.current.releasePointerCapture(e.pointerId);
    suppressClick.current = performance.now() + 350;
    const w = width(), reveal = x * sign;
    if (reveal > w * 1.6) {onOpen(null); setX(0); action?.onSelect(); return;}
    if (reveal > w / 2) {onOpen(id); setX(sign * w);} else {onOpen(null); setX(0);}
  }
  function cancel() {gesture.current = null; setDragging(false); setX(open ? sign * width() : 0);}
  const style = {'--swipe-x': `${x}px`, transition: dragging || reduced() ? 'none' : undefined} as CSSProperties;
  return <div {...attrs} className={cn('swipe', open && 'swipe-open', dragging && 'swipe-dragging', className)} data-swipe-row={id}>
    {action && <div ref={actions} className="swipe-actions" aria-hidden={!open}>
      <button type="button" tabIndex={open ? 0 : -1} className="swipe-action" data-tone={action.tone ?? 'neutral'} onClick={() => {onOpen(null); action.onSelect();}}>{action.icon}<span>{action.label}</span></button>
    </div>}
    <div ref={content} className="swipe-content" style={style} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel} onLostPointerCapture={() => {if (dragging) cancel();}}
      onClickCapture={e => {
        if (performance.now() < suppressClick.current) {e.preventDefault(); e.stopPropagation(); return;}
        if (open) {e.preventDefault(); e.stopPropagation(); onOpen(null);}
      }}
      onClick={onClick}>
      {children}
    </div>
  </div>;
}
