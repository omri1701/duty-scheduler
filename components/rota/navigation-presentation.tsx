import type {ComponentProps,CSSProperties} from 'react';
import {CalendarDays,SlidersHorizontal,Users} from 'lucide-react';
import {tabsListVariants,tabsTriggerStyles} from '@/components/ui/tabs-styles';
import type {Translate} from './workspace-types';

const navigationDefinitions=[
  ['schedule',CalendarDays,'Schedule','לוח תורנויות','Schedule','לוח תורנויות'],
  ['availability',SlidersHorizontal,'Availability','אילוצים','Availability','אילוצים'],
  ['team',Users,'Team & fairness','צוות והוגנות','Team','צוות'],
] as const;
export const navigationValues=navigationDefinitions.map(([value])=>value);
export function navigationItems(t:Translate) {
  return navigationDefinitions.map(([value,Icon,en,he,shortEn,shortHe])=>({value,Icon,label:t(en,he),compact:t(shortEn,shortHe)}));
}

export function NavigationLabel({item}:{item:ReturnType<typeof navigationItems>[number]}) {
  return <><item.Icon/><span className="navigation-wide-label">{item.label}</span><span className="navigation-compact-label">{item.compact}</span></>;
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
  return <NavigationPill value="schedule" rtl={rtl}>
    <div className={tabsListVariants({variant:'line'})} data-slot="tabs-list" data-variant="line">
      {navigationItems(t).map(item=><button disabled key={item.value} className={tabsTriggerStyles} data-slot="tabs-trigger" data-state={item.value==='schedule'?'active':'inactive'}><NavigationLabel item={item}/></button>)}
    </div>
  </NavigationPill>;
}
