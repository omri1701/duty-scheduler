import type {ComponentProps,CSSProperties} from 'react';
import {CalendarDays,CalendarCheck,House,Users} from 'lucide-react';
import {tabsListVariants,tabsTriggerStyles} from '@/components/ui/tabs-styles';
import type {Translate} from './workspace-types';

// Home · Schedule · Availability · Team (decision 2026-11-06).
const navigationDefinitions=[
  ['home',House,'Home','בית'],
  ['schedule',CalendarDays,'Schedule','לוח'],
  ['availability',CalendarCheck,'Availability','אילוצים'],
  ['team',Users,'Team','צוות'],
] as const;
export type NavigationValue=typeof navigationDefinitions[number][0];
export const navigationValues=navigationDefinitions.map(([value])=>value);
export function navigationItems(t:Translate) {
  return navigationDefinitions.map(([value,Icon,en,he])=>({value,Icon,label:t(en,he),compact:t(en,he)}));
}

export function NavigationLabel({item}:{item:ReturnType<typeof navigationItems>[number]}) {
  return <><item.Icon aria-hidden="true"/><span className="navigation-label">{item.label}</span></>;
}

// Loading and interactive navigation share the pill, indicator and CSS tracks.
// JS supplies only the selected track index and temporary drag displacement.
export function NavigationPill({value,rtl,children,style,...props}:ComponentProps<'div'>&{value:string;rtl:boolean}) {
  const index=Math.max(0,navigationValues.findIndex(tab=>tab===value));
  return <div {...props} className="mobile-navigation" style={{'--nav-count':navigationValues.length,'--selection-index':rtl?navigationValues.length-1-index:index,...style} as CSSProperties}>
    <span className="mobile-nav-selection" aria-hidden="true"/>
    {children}
  </div>;
}

export function LoadingNavigation({t,rtl}:{t:Translate;rtl:boolean}) {
  return <NavigationPill value="home" rtl={rtl}>
    <div className={tabsListVariants({variant:'line'})} data-slot="tabs-list" data-variant="line">
      {navigationItems(t).map(item=><button disabled key={item.value} className={tabsTriggerStyles} data-slot="tabs-trigger" data-state={item.value==='home'?'active':'inactive'}><NavigationLabel item={item}/></button>)}
    </div>
  </NavigationPill>;
}
