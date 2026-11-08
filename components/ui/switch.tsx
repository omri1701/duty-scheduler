'use client';
import type {ComponentProps} from 'react';
import {Switch as SwitchPrimitive} from 'radix-ui';
import {cn} from '@/lib/utils';

/** An iOS-style toggle. */
export function Switch({className, ...props}: ComponentProps<typeof SwitchPrimitive.Root>) {
  return <SwitchPrimitive.Root data-slot="switch" {...props} className={cn('switch', className)}>
    <SwitchPrimitive.Thumb className="switch-thumb"/>
  </SwitchPrimitive.Root>;
}
