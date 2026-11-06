// Each member's notification switches (duty_notification_settings). A missing row means
// these defaults. Times are HH:MM in Asia/Jerusalem.
export type NotificationSettings = {deadlines: boolean; published: boolean; swaps: boolean; edits: boolean; evening: boolean; eveningTime: string;
  morning: boolean; morningTime: string; members: boolean};
export type NotificationState = NotificationSettings & {devices: number};
export const DEFAULT_SETTINGS: NotificationSettings = {deadlines: true, published: true, swaps: true, edits: true, evening: true, eveningTime: '18:00',
  morning: true, morningTime: '08:30', members: true};
export const SWITCHES = ['deadlines', 'published', 'swaps', 'edits', 'evening', 'morning', 'members'] as const;
export type Switch = typeof SWITCHES[number];

export const validTime = (value: unknown): value is string => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

/** Validates the RPC's JSON; throws a user-facing message when it isn't that shape. */
export function readNotificationState(value: unknown): NotificationState {
  const v = value as Record<string, unknown> | null;
  if (typeof v !== 'object' || v === null || SWITCHES.some(key => typeof v[key] !== 'boolean') || !validTime(v.eveningTime) || !validTime(v.morningTime)
    || !Number.isSafeInteger(v.devices) || (v.devices as number) < 0) throw Error('Could not load notification settings. Please try again.');
  return {...Object.fromEntries(SWITCHES.map(key => [key, v[key]])) as Record<Switch, boolean>, eveningTime: v.eveningTime, morningTime: v.morningTime, devices: v.devices as number};
}

/** Exactly the keys the checked RPC accepts. */
export function settingsPayload(state: NotificationSettings): NotificationSettings {
  if (!validTime(state.eveningTime) || !validTime(state.morningTime)) throw Error('Invalid notification time');
  return {deadlines: state.deadlines, published: state.published, swaps: state.swaps, edits: state.edits, evening: state.evening,
    eveningTime: state.eveningTime, morning: state.morning, morningTime: state.morningTime, members: state.members};
}

/** The tab and month a notification opens (`/?tab=schedule&month=2026-12`). */
export function deepLink(search: string): {tab?: 'schedule' | 'availability' | 'team'; month?: string} {
  const query = new URLSearchParams(search), tab = query.get('tab'), month = query.get('month');
  return {...(tab === 'schedule' || tab === 'availability' || tab === 'team' ? {tab} : {}), ...(month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? {month} : {})};
}
