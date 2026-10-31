'use client';
import {useEffect, useRef, useState} from 'react';
import {LockKeyhole} from 'lucide-react';
import type {Translate} from './workspace-types';

export type PieSlice = {id: string; name: string; color: string; target: number; temporary: number; permanent: number; locked: number};

const TAU = Math.PI * 2, CENTER = 100, OUTER = 94, INNER = 62, GAP = .014;
const points = (units: number) => String(units / 2);
const signed = (units: number) => `${units > 0 ? '+' : '−'}${points(Math.abs(units))}`;
const at = (angle: number, radius: number) => `${(CENTER + radius * Math.sin(angle)).toFixed(3)} ${(CENTER - radius * Math.cos(angle)).toFixed(3)}`;
/** One donut segment, clockwise from the top; a lone member is a full ring. */
function arc(start: number, end: number, outer: number) {
  if (end - start >= TAU - 1e-6) {
    return `M ${at(0, outer)} A ${outer} ${outer} 0 1 1 ${at(Math.PI, outer)} A ${outer} ${outer} 0 1 1 ${at(0, outer)} Z `
      + `M ${at(0, INNER)} A ${INNER} ${INNER} 0 1 0 ${at(Math.PI, INNER)} A ${INNER} ${INNER} 0 1 0 ${at(0, INNER)} Z`;
  }
  const large = end - start > Math.PI ? 1 : 0;
  return `M ${at(start, outer)} A ${outer} ${outer} 0 ${large} 1 ${at(end, outer)} L ${at(end, INNER)} A ${INNER} ${INNER} 0 ${large} 0 ${at(start, INNER)} Z`;
}

/** Eases displayed values toward their targets so slices grow and shrink. */
function useTween(targets: Record<string, number>) {
  const [shown, setShown] = useState(targets), from = useRef(targets), frame = useRef(0);
  const key = JSON.stringify(targets);
  useEffect(() => {
    const goal: Record<string, number> = JSON.parse(key), start = {...from.current}, began = performance.now();
    cancelAnimationFrame(frame.current);
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {from.current = goal; frame.current = requestAnimationFrame(() => setShown(goal)); return;}
    const step = (now: number) => {
      // A gentle overshoot: slices settle like a spring.
      const p = Math.min(1, (now - began) / 650), ease = 1 + 2.1 * Math.pow(p - 1, 3) + 1.1 * Math.pow(p - 1, 2);
      const next = Object.fromEntries([...new Set([...Object.keys(start), ...Object.keys(goal)])]
        .map(id => [id, (start[id] ?? 0) + ((goal[id] ?? 0) - (start[id] ?? 0)) * ease]));
      from.current = next; setShown(next);
      if (p < 1) frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame.current);
  }, [key]);
  return shown;
}

/** Points per member for the month. Hover, tap, or focus the member's row for details. */
export function PlanPie({slices, configured, total, active, onActive, rtl, t}: {
  slices: PieSlice[]; configured: number; total: number; active: string | null;
  onActive: (id: string | null) => void; rtl: boolean; t: Translate;
}) {
  const shown = useTween(Object.fromEntries(slices.map(s => [s.id, Math.max(0, s.target)])));
  const sum = slices.reduce((n, s) => n + Math.max(0, shown[s.id] ?? 0), 0);
  const focus = slices.find(s => s.id === active);
  const locked = slices.reduce((n, s) => n + s.locked, 0);
  let cursor = 0;
  const arcs = sum > 0 ? slices.map(s => {
    const size = (Math.max(0, shown[s.id] ?? 0) / sum) * TAU, start = cursor; cursor += size;
    const pad = slices.length > 1 && size > GAP * 3 ? GAP : 0, mid = start + size / 2;
    return {...s, size, d: size > 1e-4 ? arc(start + pad, start + size - pad, active === s.id ? OUTER + 4 : OUTER) : '', mid};
  }) : [];
  const summary = slices.map(s => `${s.name} ${points(s.target)}`).join(', ');
  return <figure className="plan-pie" data-active={active ?? undefined}>
    <svg viewBox="0 0 200 200" role="img" aria-label={`${t('Points by engineer', 'נקודות לפי מהנדס')}: ${summary}`}
      // Pointing at the pie never moves focus: a blurred row would clear the tapped slice.
      // A tap on the centre or track returns to the month total.
      onPointerDown={e => e.preventDefault()} onPointerUp={() => onActive(null)} onPointerLeave={e => {if (e.pointerType === 'mouse') onActive(null);}}>
      <circle className="plan-pie-track" cx={CENTER} cy={CENTER} r={(OUTER + INNER) / 2} strokeWidth={OUTER - INNER}/>
      <g transform={rtl ? 'translate(200 0) scale(-1 1)' : undefined}>
        {arcs.map(s => s.d && <path key={s.id} d={s.d} fill={s.color} data-engineer={s.id}
          className={`plan-slice${active === s.id ? ' active' : active ? ' dim' : ''}`}
          style={{transform: active === s.id ? `translate(${(Math.sin(s.mid) * 3).toFixed(2)}px, ${(-Math.cos(s.mid) * 3).toFixed(2)}px)` : undefined}}
          onPointerEnter={e => {if (e.pointerType === 'mouse') onActive(s.id);}}
          onPointerUp={e => {e.stopPropagation(); onActive(s.id);}}/>)}
      </g>
    </svg>
    <figcaption className="plan-pie-center" aria-hidden="true">
      {focus ? <div className="plan-pie-detail" key={focus.id}>
        <span className="plan-pie-name"><i style={{background: focus.color}}/>{focus.name}</span>
        <strong dir="ltr">{points(focus.target)}</strong><span>{t('points', 'נקודות')}</span>
        <ul>
          {!!focus.temporary && <li className="temporary"><bdi dir="ltr">{signed(focus.temporary)}</bdi> {t('temporary', 'זמני')}</li>}
          {!!focus.permanent && <li className="permanent"><bdi dir="ltr">{signed(focus.permanent)}</bdi> {t('permanent', 'קבוע')}</li>}
          {!!focus.locked && <li className="locked"><LockKeyhole className="plan-pie-lock" size={10} strokeWidth={2.4} aria-hidden="true"/><bdi dir="ltr">{points(focus.locked)}</bdi> {t('locked', 'נעול')}</li>}
          {!focus.temporary && !focus.permanent && !focus.locked && <li>{t('Fair share', 'חלק הוגן')}</li>}
        </ul>
      </div> : <div className="plan-pie-detail plan-pie-total" key="total">
        <strong dir="ltr" className={configured === total ? undefined : 'off'}>{points(configured)}</strong>
        <span><bdi dir="ltr">/ {points(total)}</bdi> {t('points', 'נקודות')}</span>
        {!!locked && <small><bdi dir="ltr">{points(locked)}</bdi> {t('locked', 'נעולות')}</small>}
      </div>}
    </figcaption>
  </figure>;
}
