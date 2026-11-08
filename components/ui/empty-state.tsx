import type {ReactNode} from 'react';
import {cn} from '@/lib/utils';

/** One icon and one line; nothing more (decision 2026-11-06). */
export function EmptyState({icon, children, action, className}: {icon: ReactNode; children: ReactNode; action?: ReactNode; className?: string}) {
  return <div className={cn('empty', className)}><span className="empty-icon" aria-hidden="true">{icon}</span><p>{children}</p>{action}</div>;
}
