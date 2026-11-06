import type { Metadata, Viewport } from 'next';
import './tailwind.css';
import './globals.css';
import {APP_DESCRIPTION, APP_NAME, APP_TAGLINE} from '@/lib/brand';
import {THEME_SCRIPT} from '@/lib/theme/theme';
export const viewport: Viewport = {width: 'device-width', initialScale: 1, viewportFit: 'cover', interactiveWidget: 'resizes-content',
  themeColor: [{media: '(prefers-color-scheme: dark)', color: '#000000'}, {media: '(prefers-color-scheme: light)', color: '#f2f3f5'}]};
export const metadata: Metadata = {title: `${APP_NAME} — ${APP_TAGLINE.en}`, description: APP_DESCRIPTION,
  icons: {icon: '/favicon.svg', shortcut: '/favicon.svg', apple: '/apple-touch-icon.png'},
  appleWebApp: {capable: true, title: APP_NAME, statusBarStyle: 'default'}};
export default function Layout({children}: {children: React.ReactNode}) {
  // The theme is resolved before paint (lib/theme/theme.ts); React then owns data-theme.
  return <html lang="en" suppressHydrationWarning>
    <head><script dangerouslySetInnerHTML={{__html: THEME_SCRIPT}}/></head>
    <body>{children}</body>
  </html>;
}
