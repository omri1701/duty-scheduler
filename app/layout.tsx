import type { Metadata, Viewport } from 'next';
import './tailwind.css';
import './globals.css';
import {APP_DESCRIPTION, APP_NAME} from '@/lib/brand';
import {THEME_SCRIPT} from '@/lib/theme/theme';
export const viewport: Viewport = {width: 'device-width', initialScale: 1, viewportFit: 'cover', interactiveWidget: 'resizes-content'};
// No viewport themeColor: React re-inserts those tags after hydration with their first colours, which a
// theme change then misses. THEME_SCRIPT owns the one theme-color tag instead (lib/theme/theme.ts).
export const metadata: Metadata = {title: APP_NAME, description: APP_DESCRIPTION,
  icons: {icon: [{url: '/favicon-32.png', sizes: '32x32', type: 'image/png'}, {url: '/favicon-48.png', sizes: '48x48', type: 'image/png'}], shortcut: '/favicon-32.png', apple: '/apple-touch-icon.png'},
  appleWebApp: {capable: true, title: APP_NAME, statusBarStyle: 'default'}};
// width, height, points width, points height, scale.
const SPLASH: [number, number, number, number, number][] = [[1290, 2796, 430, 932, 3], [1179, 2556, 393, 852, 3], [1170, 2532, 390, 844, 3], [1284, 2778, 428, 926, 3], [1125, 2436, 375, 812, 3], [828, 1792, 414, 896, 2], [750, 1334, 375, 667, 2], [1242, 2208, 414, 736, 3]];
export default function Layout({children}: {children: React.ReactNode}) {
  // The theme is resolved before paint (lib/theme/theme.ts); React then owns data-theme.
  return <html lang="en" suppressHydrationWarning>
    <head>
      <script dangerouslySetInnerHTML={{__html: THEME_SCRIPT}}/>
      {/* iOS startup screens (scripts/render-icons.mjs), matched by device points and scale. */}
      {SPLASH.map(([w, h, pw, ph, r]) => <link key={`${w}x${h}`} rel="apple-touch-startup-image" href={`/splash/${w}x${h}.png`}
        media={`screen and (device-width: ${pw}px) and (device-height: ${ph}px) and (-webkit-device-pixel-ratio: ${r})`}/>)}
    </head>
    <body>
      {/* The notch / status-bar strip: always the theme's page colour and opaque, so iOS shows a solid colour
          there that follows every theme change and never content blurred underneath. */}
      <div className="safe-top" aria-hidden="true"/>
      {children}
    </body>
  </html>;
}
