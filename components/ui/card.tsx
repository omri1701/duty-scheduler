import type {ComponentProps, ReactNode} from 'react';
import {cn} from '@/lib/utils';

/** A soft surface. `inset` draws grouped rows without padding; `tone` tints it. */
export function Card({className, inset = false, tone = 'surface', ...props}: ComponentProps<'section'> & {inset?: boolean; tone?: 'surface' | 'brand' | 'soft' | 'warn'}) {
  return <section {...props} data-tone={tone} className={cn('card', inset && 'card-inset', className)}/>;
}

/** A small uppercase caption above a card or list, with an optional trailing action. */
export function SectionTitle({children, action, className}: {children: ReactNode; action?: ReactNode; className?: string}) {
  return <div className={cn('section-title', className)}><h3>{children}</h3>{action}</div>;
}
