import type {ComponentProps, ReactNode} from 'react';
import {ChevronRight} from 'lucide-react';
import {cn} from '@/lib/utils';

type RowProps = {
  lead?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  trail?: ReactNode;
  /** Draws a chevron; the row is a button when onClick is given. */
  chevron?: boolean;
  tone?: 'default' | 'danger' | 'muted';
  className?: string;
};

/** One line in a grouped list (iOS Settings style): lead, title/subtitle, trailing value. */
export function ListRow({lead, title, subtitle, trail, chevron = false, tone = 'default', className, ...props}: RowProps & Omit<ComponentProps<'button'>, 'title'>) {
  const interactive = !!props.onClick || !!props.type;
  const body = <>
    {lead && <span className="row-lead">{lead}</span>}
    <span className="row-body"><span className="row-title">{title}</span>{subtitle && <span className="row-subtitle">{subtitle}</span>}</span>
    {trail && <span className="row-trail">{trail}</span>}
    {chevron && <ChevronRight className="row-chevron" aria-hidden="true"/>}
  </>;
  const classes = cn('row', interactive && 'row-interactive', className);
  if (interactive) return <button type="button" {...props} data-tone={tone} className={classes}>{body}</button>;
  return <div data-tone={tone} className={classes}>{body}</div>;
}
