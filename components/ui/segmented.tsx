'use client';
import type {CSSProperties, ReactNode} from 'react';
import {cn} from '@/lib/utils';

export type SegmentOption<T extends string> = {value: T; label: ReactNode; icon?: ReactNode; disabled?: boolean};

/** An iOS segmented control with a sliding thumb; keyboard arrows move the selection. */
export function Segmented<T extends string>({value, onChange, options, label, size = 'md', className, disabled = false}: {
  value: T; onChange: (value: T) => void; options: SegmentOption<T>[]; label: string; size?: 'sm' | 'md'; className?: string; disabled?: boolean;
}) {
  const index = Math.max(0, options.findIndex(o => o.value === value));
  return <div role="radiogroup" aria-label={label} className={cn('seg', size === 'sm' && 'seg-sm', className)} style={{'--seg-count': options.length, '--seg-index': index} as CSSProperties}
    onKeyDown={e => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const rtl = getComputedStyle(e.currentTarget).direction === 'rtl';
      const step = (e.key === 'ArrowRight') !== rtl ? 1 : -1;
      const next = options[(index + step + options.length) % options.length];
      if (next && !next.disabled) {onChange(next.value); (e.currentTarget.querySelectorAll<HTMLButtonElement>('[role=radio]')[(index + step + options.length) % options.length])?.focus();}
    }}>
    <span className="seg-thumb" aria-hidden="true"/>
    {options.map(o => <button key={o.value} type="button" role="radio" aria-checked={o.value === value} disabled={disabled || o.disabled} tabIndex={o.value === value ? 0 : -1}
      className={cn('seg-item', o.value === value && 'selected')} onClick={() => onChange(o.value)}>{o.icon}<span>{o.label}</span></button>)}
  </div>;
}
