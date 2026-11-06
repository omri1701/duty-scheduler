import type {MetadataRoute} from 'next';

// Home Screen app (decision 2026-11-06): iPhone receives Web Push only from an app added
// to the Home Screen (iOS 16.4+), which needs this manifest with display "standalone".
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Duty — Team rota', short_name: 'Duty', description: 'Plan a fair month, together.',
    id: '/', start_url: '/', scope: '/', display: 'standalone', background_color: '#ffffff', theme_color: '#174b42',
    icons: [
      {src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any'},
      {src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any'},
      {src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable'},
    ],
  };
}
