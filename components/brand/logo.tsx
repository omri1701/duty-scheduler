import type {CSSProperties} from 'react';
import {APP_NAME, LOGO_SIZES, logoSrc} from '@/lib/brand';

const srcSet = (type: 'png' | 'webp') => LOGO_SIZES.map(size => `${logoSrc(size, type)} ${size}w`).join(', ');

/** The round logo (already says "miko") and the name: the only component that draws the brand.
 * The browser picks the WebP (or PNG) size for the display size × pixel ratio. */
export function Logo({size = 36, className = ''}: {size?: number; className?: string}) {
  return <span className={`logo ${className}`} style={{'--logo-size': `${size}px`} as CSSProperties} aria-hidden="true">
    <picture>
      <source type="image/webp" srcSet={srcSet('webp')} sizes={`${size}px`}/>
      <img src={logoSrc(LOGO_SIZES[1], 'png')} srcSet={srcSet('png')} sizes={`${size}px`} alt="" width={size} height={size} decoding="async" draggable={false}/>
    </picture>
  </span>;
}

export function Wordmark({size = 30, context, className = ''}: {size?: number; context?: string; className?: string}) {
  return <span className={`wordmark ${className}`} style={{'--logo-size': `${size}px`} as CSSProperties}>
    <Logo size={size}/>
    <span className="wordmark-name">{APP_NAME}</span>
    {context && <span className="wordmark-context">{context}</span>}
  </span>;
}
