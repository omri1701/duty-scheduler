// The reminder-time wheels (decision 2026-11-06): hours 00–23 and quarter-hour minutes, the
// steps the 15-minute clock can keep. Pure value mapping, shared by the component and tests.
export const WHEEL_ROW = 44;
export const HOURS: readonly number[] = Array.from({length: 24}, (_, hour) => hour);
export const QUARTERS: readonly number[] = [0, 15, 30, 45];
const pad = (n: number) => String(n).padStart(2, '0');

/** HH:MM to wheel values; anything off-step moves down to its quarter hour (like the migration). */
export function splitTime(value: string): {hour: number; minute: number} {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return {hour: 0, minute: 0};
  return {hour: Math.min(23, Number(match[1])), minute: Math.floor(Math.min(59, Number(match[2])) / 15) * 15};
}

export const joinTime = (hour: number, minute: number) => `${pad(hour)}:${pad(minute)}`;
export const twoDigits = pad;

/** The item under the centre band for a wheel scrolled to scrollTop (items are WHEEL_ROW tall). */
export function centredIndex(scrollTop: number, count: number, row = WHEEL_ROW): number {
  return Math.max(0, Math.min(count - 1, Math.round(scrollTop / row)));
}

/** Spinbutton keys: Up/Down one step, PageUp/PageDown a page, Home/End the ends; no wrap.
 * null for any other key. */
export function keyedIndex(key: string, index: number, count: number, page: number): number | null {
  const clamp = (i: number) => Math.max(0, Math.min(count - 1, i));
  switch (key) {
    case 'ArrowUp': return clamp(index + 1);
    case 'ArrowDown': return clamp(index - 1);
    case 'PageUp': return clamp(index + page);
    case 'PageDown': return clamp(index - page);
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return null;
  }
}
