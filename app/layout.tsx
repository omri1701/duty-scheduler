import type { Metadata, Viewport } from 'next';
import './globals.css';
export const viewport: Viewport = {width: 'device-width', initialScale: 1, viewportFit: 'cover', interactiveWidget: 'resizes-content'};
export const metadata:Metadata={title:'Duty — Team rota',description:'Plan a fair month, together. Engineering duty rota demo.',icons:{icon:'/favicon.svg',shortcut:'/favicon.svg'}};
export default function Layout({children}:{children:React.ReactNode}){return <html lang="en"><body>{children}</body></html>}
