'use client';
import type {ReactNode} from 'react';
import {Ellipsis} from 'lucide-react';
import {MonthTitle} from './month-title';
import {DropdownMenu} from 'radix-ui';
import {Button} from '@/components/ui/button';
import {Chip} from '@/components/ui/chip';
import type {Translate} from './workspace-types';

export type MenuItem = {key: string; label: string; icon?: ReactNode; onSelect: () => void; disabled?: boolean; reason?: string; danger?: boolean};
export type PrimaryAction = {label: string; /** Shown in place while busy (decision 2026-11-07); the bar's button width holds both. */ busyLabel?: string; onClick: () => void; disabled?: boolean; reason?: string; icon?: ReactNode; busy?: boolean; dot?: boolean; variant?: 'default' | 'secondary'};

/** The month heading with its chevrons, the status chip, one primary action and a ⋯ menu for
 * rare actions (decision 2026-11-06). Everyone sees the heading; the actions are the admin's. */
export function MonthBar({month, label, status, t, onChange, primary, menu, loading = false, children, onSwipe, arrival}: {
  month: string; label: string; status?: {text: string; tone: 'ok' | 'neutral' | 'warn'}; t: Translate; onChange?: (offset: number) => void;
  primary?: PrimaryAction; menu?: MenuItem[]; loading?: boolean; children?: ReactNode; onSwipe?: (offset: number) => void; arrival?: 'roll' | 'blur';
}) {
  const rtl = t('ltr', 'rtl') === 'rtl';
  return <div className="month-bar">
    <MonthTitle month={month} label={label} t={t} onChange={onChange} loading={loading} onSwipe={onSwipe} arrival={arrival}
      status={status && <Chip tone={status.tone} size="sm" className="month-status">{status.text}</Chip>}/>
    {(primary || menu?.length || children) && <div className="month-actions">
      {children}
      {primary && <Button className="month-primary" variant={primary.variant ?? 'default'} disabled={primary.disabled || primary.busy} title={primary.reason} aria-label={primary.busy && primary.busyLabel ? primary.busyLabel : primary.label} aria-busy={primary.busy || undefined} onClick={primary.onClick}>
        {primary.icon}<span>{primary.busy && primary.busyLabel ? primary.busyLabel : primary.label}</span>{primary.dot && <span className="review-dot" aria-hidden="true"/>}
      </Button>}
      {!!menu?.length && <DropdownMenu.Root dir={rtl ? 'rtl' : 'ltr'}>
        <DropdownMenu.Trigger asChild>
          <Button variant="secondary" size="icon" aria-label={t('Month actions', 'פעולות לחודש')} className="month-menu"><Ellipsis/></Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="menu" align="end" sideOffset={8} collisionPadding={12}>
            {menu.map(item => <DropdownMenu.Item key={item.key} disabled={item.disabled} title={item.reason} data-danger={item.danger || undefined} onSelect={item.onSelect}>
              {item.icon}<span>{item.label}</span>
            </DropdownMenu.Item>)}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>}
    </div>}
  </div>;
}
