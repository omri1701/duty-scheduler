// The MiKo wordmark font, in this one place (self-hosted at build by next/font); body text keeps
// the system font. Not final (2026-11-07): to try another Google font, change only the import name.
import {Sora as WordmarkFont} from 'next/font/google';

export const wordmarkFont = WordmarkFont({subsets: ['latin'], weight: ['700', '800'], display: 'swap', variable: '--font-wordmark'});
