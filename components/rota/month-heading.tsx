import {ChevronLeft,ChevronRight} from 'lucide-react';
import {Button} from '@/components/ui/button';
import type {Translate} from './workspace-types';

export function MonthHeading({label,t,onChange,loading=false}:{label:string;t:Translate;onChange?:(offset:number)=>void;loading?:boolean}) {
  return <div className="month-title">
    <Button variant="outline" size="icon" className={loading?'skeleton-content':undefined} disabled={loading} onClick={onChange?()=>onChange(-1):undefined} aria-label={t('Previous month','חודש קודם')}><ChevronLeft/></Button>
    <h2>{loading?<span className="skeleton-content">{label}</span>:label}</h2>
    <Button variant="outline" size="icon" className={loading?'skeleton-content':undefined} disabled={loading} onClick={onChange?()=>onChange(1):undefined} aria-label={t('Next month','חודש הבא')}><ChevronRight/></Button>

  </div>;
}
