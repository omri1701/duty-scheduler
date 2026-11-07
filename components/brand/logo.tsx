import type {CSSProperties} from 'react';
import {APP_NAME} from '@/lib/brand';

/** The "d." mark and the wordmark: the only component that draws the brand. */
export function Logo({size = 36, className = ''}: {size?: number; className?: string}) {
  return <span className={`logo ${className}`} style={{'--logo-size': `${size}px`} as CSSProperties} aria-hidden="true">
    <span className="logo-letter">d</span><span className="logo-dot"/>
  </span>;
}

export function Wordmark({size = 30, context, className = ''}: {size?: number; context?: string; className?: string}) {
  return <span className={`wordmark ${className}`} style={{'--logo-size': `${size}px`} as CSSProperties}>
    <Logo size={size}/>
    <span className="wordmark-name">{APP_NAME.toLowerCase()}</span>
    {context && <span className="wordmark-context">{context}</span>}
  </span>;
}
