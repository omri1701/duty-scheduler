import type {ComponentProps} from 'react';
import {cn} from '@/lib/utils';

export type ChipTone = 'neutral' | 'brand' | 'ok' | 'warn' | 'danger' | 'info' | 'member';

/** A small rounded label. `member` reads the member colour variables (lib/theme/palette.ts). */
export function Chip({tone = 'neutral', size = 'md', className, ...props}: ComponentProps<'span'> & {tone?: ChipTone; size?: 'sm' | 'md'}) {
  return <span {...props} data-tone={tone} className={cn('chip', size === 'sm' && 'chip-sm', tone === 'member' && 'member-tint', className)}/>;
}
