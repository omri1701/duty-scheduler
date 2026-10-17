import type {ReactNode} from 'react';
import {Download} from 'lucide-react';
import type {Translate} from './workspace-types';

export function BrandContent({t}:{t:Translate}) {
  return <><span className="brand-symbol">d<span>·</span></span>{' '}duty<span className="brand-divider"/><span className="brand-context">{t('Engineering','הנדסה')}</span></>;
}

export function WorkspaceHeader({brand,children}:{brand:ReactNode;children:ReactNode}) {
  return <header className="topbar">{brand}<div className="top-actions">{children}</div></header>;
}

export function WorkspaceFooter({t,onExport,loading=false}:{t:Translate;onExport?:()=>void;loading?:boolean}) {
  return <footer className="app-footer"><span>Duty</span><button disabled={loading} onClick={onExport} className={loading?'skeleton-content':undefined}><Download size={14}/>{t('Export backup','ייצוא גיבוי')}</button></footer>;
}
