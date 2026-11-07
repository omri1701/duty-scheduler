import type {ComponentProps} from 'react';
import {cn} from '@/lib/utils';

/** A placeholder that reserves the final size, so loaded content never shifts the page. */
export function Skeleton({className, width, height, round = false, style, ...props}: ComponentProps<'span'> & {width?: number | string; height?: number | string; round?: boolean}) {
  return <span aria-hidden="true" {...props} className={cn('skel', round && 'skel-round', className)} style={{width, height, ...style}}/>;
}
