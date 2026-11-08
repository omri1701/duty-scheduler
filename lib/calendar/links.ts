// Subscription links for the personal calendar feed (decision 2026-11-06). Pure.
export const feedUrl = (origin: string, token: string) => `${origin.replace(/\/$/, '')}/api/calendar/${token}.ics`;
/** Apple Calendar (and most desktop calendars) subscribe from webcal:// with one tap. */
export const webcalUrl = (url: string) => url.replace(/^https?:\/\//, 'webcal://');
/** Google Calendar's add-by-URL page, prefilled. Google fetches the feed from its servers. */
export const googleUrl = (url: string) => `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcalUrl(url))}`;
