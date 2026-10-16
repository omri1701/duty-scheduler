'use client';
import {useLayoutEffect, useRef, useState, type CSSProperties} from 'react';
import {CalendarDays, SlidersHorizontal, Users} from 'lucide-react';
import {TabsList, TabsTrigger} from '@/components/ui/tabs';
import {tactileTick} from '@/lib/tactile';
import type {Translate} from './workspace-types';

const values = ['schedule', 'availability', 'team'];
export function MobileNavigation({value, onChange, t, rtl, disabled}: {
  value: string; onChange: (value: string) => void; t: Translate; rtl: boolean; disabled: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const gesture = useRef<{id: number; x: number; y: number; sliding: boolean; canceled: boolean; target: number} | null>(null);
  const [position, setPosition] = useState<{x: number; width: number; sliding: boolean}>({x: 0, width: 0, sliding: false});
  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    const sync = () => {
      if (gesture.current?.sliding) return;
      const button = node.querySelector<HTMLElement>(`[data-state="active"]`);
      if (button) setPosition({x: button.offsetLeft, width: button.offsetWidth, sliding: false});
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(node);
    return () => observer.disconnect();
  }, [value, rtl]);
  function reset() {
    gesture.current = null;
    const button = root.current?.querySelector<HTMLElement>('[data-state="active"]');
    if (button) setPosition({x: button.offsetLeft, width: button.offsetWidth, sliding: false});
  }
  return <div ref={root} className="mobile-navigation" data-sliding={position.sliding || undefined}
    style={{'--selection-x': `${position.x}px`, '--selection-width': `${position.width}px`} as CSSProperties}
    onPointerDown={e => {
      if (disabled || !e.isPrimary || e.button !== 0) return;
      gesture.current = {id: e.pointerId, x: e.clientX, y: e.clientY, sliding: false, canceled: false, target: values.indexOf(value)};
    }}
    onPointerMove={e => {
      const g = gesture.current, node = root.current;
      if (!g || g.id !== e.pointerId || g.canceled || !node) return;
      const dx = e.clientX - g.x, dy = e.clientY - g.y;
      if (!g.sliding) {
        if (Math.abs(dy) > 8 && Math.abs(dy) >= Math.abs(dx)) {g.canceled = true; return;}
        if (Math.abs(dx) < 8 || Math.abs(dx) <= Math.abs(dy)) return;
        g.sliding = true;
        node.setPointerCapture(e.pointerId);
      }
      const buttons = [...node.querySelectorAll<HTMLElement>('[role="tab"]')];
      const box = node.getBoundingClientRect();
      const width = buttons[0].offsetWidth;
      const x = Math.max(buttons.reduce((n, b) => Math.min(n, b.offsetLeft), Infinity),
        Math.min(box.width - width - 4, e.clientX - box.left - width / 2));
      const index = buttons.reduce((best, b, i) =>
        Math.abs(b.offsetLeft - x) < Math.abs(buttons[best].offsetLeft - x) ? i : best, 0);
      if (g.target !== index) tactileTick();
      g.target = index;
      setPosition({x, width, sliding: true});
    }}
    onPointerUp={e => {
      const g = gesture.current;
      if (!g || g.id !== e.pointerId) return;
      if (g.sliding && !disabled) {
        onChange(values[g.target]);
        root.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[g.target]?.focus({preventScroll: true});
      }
      reset();
    }}
    onPointerCancel={reset} onLostPointerCapture={e => {if (e.target === e.currentTarget) reset();}}
    onClickCapture={e => {if (gesture.current?.canceled) {e.preventDefault(); e.stopPropagation(); reset();}}}>
    <span className="mobile-nav-selection" aria-hidden="true"/>
    <TabsList variant="line" aria-label={t('Main navigation', 'ניווט ראשי')}>
      <TabsTrigger value="schedule" disabled={disabled}><CalendarDays/>{t('Schedule', 'לוח תורנויות')}</TabsTrigger>
      <TabsTrigger value="availability" disabled={disabled}><SlidersHorizontal/>{t('Availability', 'אילוצים')}</TabsTrigger>
      <TabsTrigger value="team" aria-label={t('Team & fairness', 'צוות והוגנות')} disabled={disabled}><Users/>{t('Team', 'צוות')}</TabsTrigger>
    </TabsList>
  </div>;
}
