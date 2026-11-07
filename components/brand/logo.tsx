import type {CSSProperties} from 'react';
import {APP_NAME, LOGO_SRC} from '@/lib/brand';

/** The logo mark and the name: the only component that draws the brand. */
export function Logo({size = 36, className = ''}: {size?: number; className?: string}) {
  return <span className={`logo ${className}`} style={{'--logo-size': `${size}px`} as CSSProperties} aria-hidden="true">
    {/* eslint-disable-next-line @next/next/no-img-element -- a small static SVG; next/image adds nothing */}
    <img src={LOGO_SRC} alt="" width={size} height={size} decoding="async" draggable={false}/>
  </span>;
}

export function Wordmark({size = 30, context, className = ''}: {size?: number; context?: string; className?: string}) {
  return <span className={`wordmark ${className}`} style={{'--logo-size': `${size}px`} as CSSProperties}>
    <Logo size={size}/>
    <span className="wordmark-name">{APP_NAME}</span>
    {context && <span className="wordmark-context">{context}</span>}
  </span>;
}
