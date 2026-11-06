'use client';
// iPhone-style time wheels (decision 2026-11-06): hours 00–23 and minutes 00/15/30/45 side by side,
// always left to right. Each wheel is a native scroll-snap list (touch momentum, mouse wheel),
// reported once scrolling settles; items fade and shrink away from the centre band. Each wheel
// is also a focusable spinbutton (Up/Down, PageUp/PageDown, Home/End). Self-contained, no library.
import {useEffect, useLayoutEffect, useRef} from 'react';
import {HOURS, QUARTERS, WHEEL_ROW, centredIndex, joinTime, keyedIndex, splitTime, twoDigits} from '@/lib/push/time-wheel';

type WheelProps = {values: readonly number[]; value: number; label: string; page: number; onSettle: (value: number) => void};

function Wheel({values, value, label, page, onSettle}: WheelProps) {
  const ref = useRef<HTMLDivElement>(null), index = Math.max(0, values.indexOf(value));
  const latest = useRef({value, onSettle});
  useEffect(() => {latest.current = {value, onSettle};});
  const smooth = () => !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Fade and shrink each item by its distance from the centre (in rows, capped).
  const paint = () => {
    const el = ref.current;
    if (!el) return;
    const centre = el.scrollTop / WHEEL_ROW;
    Array.from(el.children).forEach((item, i) => (item as HTMLElement).style.setProperty('--d', Math.min(2.5, Math.abs(i - centre)).toFixed(3)));
  };

  // Show the saved value (on opening, or after a failed save put it back) without animation.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && centredIndex(el.scrollTop, values.length) !== index) el.scrollTop = index * WHEEL_ROW;
    paint();
  }, [index, values.length]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0, timer = 0;
    const settle = () => {
      window.clearTimeout(timer);
      const next = values[centredIndex(el.scrollTop, values.length)];
      if (next !== latest.current.value) latest.current.onSettle(next);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(() => {frame = 0; paint();});
      // scrollend where supported; otherwise a short quiet period after the last scroll.
      window.clearTimeout(timer);
      timer = window.setTimeout(settle, 160);
    };
    el.addEventListener('scroll', onScroll, {passive: true});
    el.addEventListener('scrollend', settle);
    return () => {el.removeEventListener('scroll', onScroll); el.removeEventListener('scrollend', settle); cancelAnimationFrame(frame); window.clearTimeout(timer);};
  }, [values]);

  const scrollToIndex = (i: number) => ref.current?.scrollTo({top: i * WHEEL_ROW, behavior: smooth() ? 'smooth' : 'auto'});
  return <div className="time-wheel-frame">
    <div ref={ref} className="time-wheel" role="spinbutton" tabIndex={0} aria-label={label}
      aria-valuemin={values[0]} aria-valuemax={values[values.length - 1]} aria-valuenow={value} aria-valuetext={twoDigits(value)}
      onKeyDown={e => {
        const next = keyedIndex(e.key, index, values.length, page);
        if (next === null) return;
        e.preventDefault();
        scrollToIndex(next);
      }}>
      {values.map((v, i) => <div key={v} className="time-wheel-item" aria-hidden="true" onClick={() => scrollToIndex(i)}>{twoDigits(v)}</div>)}
    </div>
  </div>;
}

/** Two wheels for an HH:MM value in quarter hours; onChange gets the new HH:MM when a wheel settles. */
export function TimeWheels({id, value, onChange, labels}: {id: string; value: string; onChange: (value: string) => void;
  labels: {group: string; hour: string; minute: string}}) {
  const {hour, minute} = splitTime(value);
  return <div id={id} className="time-wheels" role="group" aria-label={labels.group} dir="ltr">
    <Wheel values={HOURS} value={hour} label={labels.hour} page={6} onSettle={h => onChange(joinTime(h, minute))}/>
    <span className="time-colon" aria-hidden="true">:</span>
    <Wheel values={QUARTERS} value={minute} label={labels.minute} page={2} onSettle={m => onChange(joinTime(hour, m))}/>
  </div>;
}
