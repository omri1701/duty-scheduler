import type { State } from '@/lib/rota/engine';
export type Language = 'en' | 'he';
export type Translate = (en: string, he: string) => string;
export type FormatDate = (date: string, options?: Intl.DateTimeFormatOptions) => string;
export type UpdateDraft = (change: (state: State) => State, draft?: boolean) => Promise<boolean>;
export type DutySelection = { from: string; to: string };
