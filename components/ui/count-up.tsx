'use client';
import {useEffect, useRef, useState} from 'react';

/** Eases a number toward its target (half points keep one decimal); instant under reduced motion. */
export function useCountUp(target: number, duration = 500) {
  const [shown, setShown] = useState(target), from = useRef(target), frame = useRef(0);
  useEffect(() => {
    cancelAnimationFrame(frame.current);
    const start = from.current, began = performance.now();
    if (start === target) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {from.current = target; frame.current = requestAnimationFrame(() => setShown(target)); return () => cancelAnimationFrame(frame.current);}
    const step = (now: number) => {
      const p = Math.min(1, (now - began) / duration), ease = 1 - Math.pow(1 - p, 3);
      const next = start + (target - start) * ease;
      from.current = next; setShown(p < 1 ? next : target);
      if (p < 1) frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame.current);
  }, [target, duration]);
  return shown;
}

export function CountUp({value, decimals = 1, className}: {value: number; decimals?: number; className?: string}) {
  const shown = useCountUp(value);
  const text = Number.isInteger(value) && Math.abs(shown - value) < 1e-6 ? String(value) : shown.toFixed(decimals).replace(/\.0$/, '');
  return <span className={className} dir="ltr">{text}</span>;
}
