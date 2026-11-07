// The product name lives here; the logo is one source image, drawn only by components/brand/logo.tsx.
// MiKo stays Latin in both languages, with no tagline (2026-11-07).
export const APP_NAME = 'MiKo';
/** The logo: the owl with "miko" in a navy circle. Its one source is public/brand/logo.png (cut out
 * with scripts/cut-logo.mjs); scripts/render-icons.mjs renders these sizes, the favicon, Home Screen
 * icons and startup screens from it. Swap that file and re-run the script to change it everywhere. */
export const LOGO_SIZES = [96, 192, 512] as const;
export const logoSrc = (size: (typeof LOGO_SIZES)[number], type: 'png' | 'webp') => `/brand/logo-${size}.${type}`;
export const APP_DESCRIPTION = 'Plan a fair month, together.';
/** The brand is the logo's own colours (2026-11-07): navy fills, cyan only on navy/dark or as decoration.
 * app/globals.css mirrors them as --brand and --cyan. */
export const BRAND_COLOR = '#090442';
export const BRAND_CYAN = '#19f2f7';
/** Manifest background (Android launch screen): the icons' navy. */
export const BRAND_DARK = BRAND_COLOR;

