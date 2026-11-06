// The protected sender's core (app/api/push/dispatch): the database's scheduler posts
// due deliveries here; each is written in the member's language and sent with VAPID.
// It answers with one outcome per delivery, which the database records
// (duty_private.push_settle). Only explicit refusals are retried, so nothing repeats.
import {timingSafeEqual} from 'node:crypto';
import {PUSH_KINDS, pushText, type PushKind, type PushLanguage, type PushParams} from './messages.ts';
import {BASE64URL_KEY, supportedPushEndpoint} from './endpoint.ts';

export type DispatchMessage = {id: string; endpoint: string; keys: {p256dh: string; auth: string}; lang: PushLanguage; kind: PushKind;
  params: PushParams; url: string; tag: string};
export type Outcome = 'sent' | 'gone' | 'retry' | 'rejected' | 'unknown';
export type DispatchResult = {id: string; outcome: Outcome; status?: number};
/** web-push's sendNotification shape: resolves with the push service's status, or throws one. */
export type Send = (subscription: {endpoint: string; keys: {p256dh: string; auth: string}}, payload: string,
  options: {TTL: number; urgency: 'normal' | 'high'; topic?: string}) => Promise<{statusCode: number}>;

export const MAX_BODY_BYTES = 200_000, MAX_MESSAGES = 100;
const URL_PATTERN = /^\/\?[a-z]+=[A-Za-z0-9=&_-]*$/, DAY = /^\d{4}-\d{2}-\d{2}$/, MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Constant-time check of `Authorization: Bearer <secret>`. */
export function authorized(header: string | null, secret: string | undefined): boolean {
  if (!secret || secret.length < 32 || !header?.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice(7)), expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function params(value: unknown): PushParams | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>, out: PushParams = {};
  for (const key of ['deadline', 'day', 'fromDay', 'toDay', 'endDay'] as const) if (typeof p[key] === 'string' && DAY.test(p[key])) out[key] = p[key];
  if (typeof p.month === 'string' && MONTH.test(p.month)) out.month = p.month;
  for (const key of ['version', 'count'] as const) if (Number.isSafeInteger(p[key]) && (p[key] as number) > 0) out[key] = p[key] as number;
  if (p.role === 'primary' || p.role === 'secondary') out.role = p.role;
  if (typeof p.name === 'string') out.name = p.name.slice(0, 80);
  return out;
}

/** Validates the scheduler's request; null when it is not exactly that shape. */
export function parseDispatch(body: unknown): DispatchMessage[] | null {
  if (typeof body !== 'object' || body === null || !Array.isArray((body as {messages?: unknown}).messages)) return null;
  const messages = (body as {messages: unknown[]}).messages;
  if (messages.length > MAX_MESSAGES) return null;
  const parsed: DispatchMessage[] = [];
  for (const m of messages) {
    if (typeof m !== 'object' || m === null) return null;
    const x = m as Record<string, unknown>, keys = x.keys as Record<string, unknown> | undefined, p = params(x.params);
    if (typeof x.id !== 'string' || !/^\d{1,18}$/.test(x.id) || typeof x.endpoint !== 'string' || !keys || typeof keys.p256dh !== 'string'
      || typeof keys.auth !== 'string' || (x.lang !== 'en' && x.lang !== 'he') || !PUSH_KINDS.includes(x.kind as PushKind) || !p
      || typeof x.url !== 'string' || !URL_PATTERN.test(x.url) || typeof x.tag !== 'string' || !/^[a-z0-9-]{1,64}$/.test(x.tag)) return null;
    parsed.push({id: x.id, endpoint: x.endpoint, keys: {p256dh: keys.p256dh, auth: keys.auth}, lang: x.lang, kind: x.kind as PushKind, params: p, url: x.url, tag: x.tag});
  }
  return parsed;
}

/** The push service's answer: 201/200 sent, 404/410 the device is gone, 429/5xx retry later. */
export function outcome(status: number | undefined): Outcome {
  if (status === undefined) return 'unknown';
  if (status >= 200 && status < 300) return 'sent';
  if (status === 404 || status === 410) return 'gone';
  if (status === 429 || status >= 500) return 'retry';
  return 'rejected';
}

/** The notification the service worker shows (public/sw.js). */
export function payload(message: DispatchMessage) {
  return JSON.stringify({...pushText(message.kind, message.params, message.lang), url: message.url, tag: message.tag, lang: message.lang});
}

const reminder = (kind: PushKind) => kind === 'remind_evening' || kind === 'remind_morning' || kind === 'deadline_1';
export async function dispatch(messages: DispatchMessage[], send: Send): Promise<{results: DispatchResult[]}> {
  const results = await Promise.all(messages.map(async (message): Promise<DispatchResult> => {
    // Never contact anything but a known push service, with well-formed keys.
    if (!supportedPushEndpoint(message.endpoint) || !BASE64URL_KEY.p256dh.test(message.keys.p256dh) || !BASE64URL_KEY.auth.test(message.keys.auth))
      return {id: message.id, outcome: 'rejected'};
    try {
      const response = await send({endpoint: message.endpoint, keys: message.keys}, payload(message),
        {TTL: reminder(message.kind) ? 6 * 3600 : 24 * 3600, urgency: reminder(message.kind) ? 'high' : 'normal', topic: message.tag.slice(0, 32)});
      return {id: message.id, outcome: outcome(response.statusCode), status: response.statusCode};
    } catch (error) {
      const status = typeof (error as {statusCode?: unknown})?.statusCode === 'number' ? (error as {statusCode: number}).statusCode : undefined;
      // No status: the request may have reached the service, so it is never resent.
      return {id: message.id, outcome: outcome(status), ...(status === undefined ? {} : {status})};
    }
  }));
  return {results};
}
