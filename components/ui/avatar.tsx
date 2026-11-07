import type {ComponentProps} from 'react';
import {initials, memberStyle} from '@/lib/theme/palette';
import {cn} from '@/lib/utils';

/** A member's initials on their colour; `size` in px. */
export function Avatar({name, color, size = 36, className, style, ...props}: ComponentProps<'span'> & {name: string; color?: string | null; size?: number}) {
  return <span {...props} className={cn('avatar member-tint', className)} style={{...memberStyle(color), width: size, height: size, fontSize: Math.round(size * .38), ...style}} aria-hidden={props['aria-label'] ? undefined : true}>
    {initials(name) || '·'}
  </span>;
}
