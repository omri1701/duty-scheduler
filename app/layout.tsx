import type { Metadata } from 'next';
import './globals.css';
export const metadata:Metadata={title:'Duty — Team rota',description:'Plan a fair month, together. Engineering duty rota demo.',icons:{icon:'/favicon.svg',shortcut:'/favicon.svg'}};
export default function Layout({children}:{children:React.ReactNode}){return <html lang="en"><body>{children}</body></html>}
