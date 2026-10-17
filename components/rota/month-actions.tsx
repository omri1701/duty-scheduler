import {DropdownMenu} from 'radix-ui';
import {Ellipsis,History,SlidersHorizontal} from 'lucide-react';
import {Button} from '@/components/ui/button';
import type {Translate} from './workspace-types';

export function MonthActions({t,readOnly,onHistory,onSettings}:{t:Translate;readOnly:boolean;onHistory:()=>void;onSettings:()=>void}) {
 return <DropdownMenu.Root defaultOpen dir={t('ltr','rtl') as 'ltr'|'rtl'}>
  <DropdownMenu.Trigger asChild><Button variant="outline" size="icon" aria-label={t('Month actions','פעולות לחודש')}><Ellipsis/></Button></DropdownMenu.Trigger>
  <DropdownMenu.Portal>
   <DropdownMenu.Content className="mobile-action-menu" align="end" sideOffset={8} collisionPadding={16}>
    <DropdownMenu.Item onSelect={onHistory}><History/>{t('Versions','גרסאות')}</DropdownMenu.Item>
    <DropdownMenu.Item disabled={readOnly} onSelect={onSettings}><SlidersHorizontal/>{t('Change month deadline','שינוי מועד אחרון לחודש')}</DropdownMenu.Item>
   </DropdownMenu.Content>
  </DropdownMenu.Portal>
 </DropdownMenu.Root>;
}
