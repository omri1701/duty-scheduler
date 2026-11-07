// The product name lives here; the logo is one file, LOGO_SRC, drawn only by components/brand/logo.tsx.
// MiKo stays Latin in both languages, with no tagline (2026-11-07).
export const APP_NAME = 'MiKo';
/** The logo (the company owl, traced from its 1024px source). Swap this file to change the logo
 * everywhere; scripts/render-icons.mjs then renders the favicon, Home Screen icons and startup screens. */
export const LOGO_SRC = '/brand/logo.svg';
export const APP_DESCRIPTION = 'Plan a fair month, together.';
/** The brand is the logo's own colours (2026-11-07): navy fills, cyan only on navy/dark or as decoration.
 * app/globals.css mirrors them as --brand and --cyan. */
export const BRAND_COLOR = '#090442';
export const BRAND_CYAN = '#19f2f7';
/** Manifest background (Android launch screen): the icons' navy. */
export const BRAND_DARK = BRAND_COLOR;

