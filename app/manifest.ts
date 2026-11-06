import type {MetadataRoute} from 'next';
import {APP_DESCRIPTION, APP_NAME, APP_TAGLINE, BRAND_COLOR, BRAND_DARK} from '@/lib/brand';

// Home Screen app (decision 2026-11-06): iPhone receives Web Push only from an app added
// to the Home Screen (iOS 16.4+), which needs this manifest with display "standalone".
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${APP_NAME} — ${APP_TAGLINE.en}`, short_name: APP_NAME, description: APP_DESCRIPTION,
    id: '/', start_url: '/', scope: '/', display: 'standalone', background_color: BRAND_DARK, theme_color: BRAND_COLOR,
    icons: [
      {src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any'},
      {src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any'},
      {src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable'},
    ],
  };
}
